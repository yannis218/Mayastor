// Implementation of K8S CSI controller interface which is mostly
// about volume creation and destruction.

'use strict';

const assert = require('assert');
const fs = require('fs').promises;
const protoLoader = require('@grpc/proto-loader');
const grpc = require('grpc-uds');
const log = require('./logger').Logger('csi');
const {
  PLUGIN_NAME,
  GrpcError,
  parseMayastorNodeId,
  isPoolAccessible,
} = require('./common');

const PROTO_PATH = __dirname + '/proto/csi.proto';
// TODO: can we generate version with commit SHA dynamically?
const VERSION = '0.1';
const PVC_RE = /pvc-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

// Load csi proto file with controller and identity services
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
  // this is to load google/descriptor.proto, otherwise you would see error:
  // unresolvable extensions: 'extend google.protobuf.FieldOptions' in .csi.v1
  includeDirs: [__dirname + '/node_modules/protobufjs'],
});
const csi = grpc.loadPackageDefinition(packageDefinition).csi.v1;

// Check that the list of volume capabilities does not contain unsupported
// capability.
function checkCapabilities(caps) {
  if (!caps) {
    throw new GrpcError(
      grpc.status.INVALID_ARGUMENT,
      'Missing volume capabilities'
    );
  }
  for (let i = 0; i < caps.length; i++) {
    let cap = caps[i];

    // TODO: Check that FS type is supported and mount options?
    if (cap.accessMode.mode != 'SINGLE_NODE_WRITER') {
      throw new GrpcError(
        grpc.status.INVALID_ARGUMENT,
        `Access mode ${cap.accessMode.mode} not supported`
      );
    }
  }
}

// Create k8s volume object as returned by CSI list volumes method.
// Input is nexus object returned by volume operator.
function createK8sVolumeObject(nexus) {
  if (!nexus) return nexus;
  return {
    volumeId: nexus.uuid,
    capacityBytes: nexus.size,
    accessibleTopology: [
      {
        segments: { 'kubernetes.io/hostname': nexus.node },
      },
    ],
  };
}

// CSI Controller implementation.
//
// It implements Identity and Controller grpc services from csi proto file.
// It relies on pool operator, when serving incoming CSI requests, which holds
// the information about available storage pools.
class CsiServer {
  // Creates new csi server
  constructor(sockPath) {
    assert.equal(typeof sockPath, 'string');
    this.server = new grpc.Server();
    this.ready = false;
    this.pools = null;
    this.volumes = null;
    this.commander = null;
    this.sockPath = sockPath;
    this.nextListContextId = 1;
    this.listContexts = {};

    // The data returned by identity service should be kept in sync with
    // responses for the same methods on storage node.
    this.server.addService(csi.Identity.service, {
      getPluginInfo: this.getPluginInfo.bind(this),
      getPluginCapabilities: this.getPluginCapabilities.bind(this),
      probe: this.probe.bind(this),
    });

    // Wrap all controller methods by a check for readiness of the csi server
    // and request/response logging to avoid repeating code.
    var self = this;
    var controllerMethods = {};
    var methodNames = [
      'createVolume',
      'deleteVolume',
      'controllerPublishVolume',
      'controllerUnpublishVolume',
      'validateVolumeCapabilities',
      'listVolumes',
      'getCapacity',
      'controllerGetCapabilities',
    ];
    methodNames.forEach(name => {
      controllerMethods[name] = function checkReady(args, cb) {
        log.trace('CSI ' + name + ' request: ' + JSON.stringify(args));

        if (!self.ready) {
          return cb(
            new GrpcError(
              grpc.status.UNAVAILABLE,
              'Not ready for serving requests'
            )
          );
        }
        return self[name](args, (err, resp) => {
          if (err) {
            log.error('CSI ' + name + ' failed: ' + err);
          } else {
            log.trace('CSI ' + name + ' response: ' + JSON.stringify(resp));
          }
          cb(err, resp);
        });
      };
    });
    // unimplemented methods
    methodNames = [
      'createSnapshot',
      'deleteSnapshot',
      'listSnapshots',
      'controllerExpandVolume',
    ];
    methodNames.forEach(name => {
      controllerMethods[name] = function notImplemented(_, cb) {
        let msg = `CSI method ${name} not implemented`;
        log.error(msg);
        cb(new GrpcError(grpc.status.UNIMPLEMENTED, msg));
      };
    });
    this.server.addService(csi.Controller.service, controllerMethods);
  }

  // Listen on UDS
  async start() {
    try {
      await fs.lstat(this.sockPath);
      log.info('Removing stale socket file ' + this.sockPath);
      await fs.unlink(this.sockPath);
    } catch (err) {
      // the file does not exist which is ok
    }
    let ok = this.server.bind(
      this.sockPath,
      grpc.ServerCredentials.createInsecure()
    );
    if (!ok) {
      log.error('CSI server failed to bind at ' + this.sockPath);
      throw new Error('Bind failed');
    }
    log.info('CSI server listens at ' + this.sockPath);
    this.server.start();
  }

  async stop() {
    var self = this;
    return new Promise((resolve, reject) => {
      log.info('Shutting down grpc server');
      self.server.tryShutdown(resolve);
    });
  }

  // Switch csi server to ready state (returned by identity.probe method).
  // This will enable serving controller grpc service requests.
  makeReady(poolOperator, volumeOperator, commander) {
    this.ready = true;
    this.pools = poolOperator;
    this.volumes = volumeOperator;
    this.commander = commander;
  }

  // Stop serving controller requests, but the identity service still works.
  // This is usually preparation for a shutdown.
  undoReady() {
    this.ready = false;
  }

  //
  // Implementation of CSI identity methods
  //

  getPluginInfo(_, cb) {
    log.debug(
      `getPluginInfo request (name=${PLUGIN_NAME}, version=${VERSION})`
    );
    cb(null, {
      name: PLUGIN_NAME,
      vendorVersion: VERSION,
      manifest: {},
    });
  }

  getPluginCapabilities(_, cb) {
    var caps = ['CONTROLLER_SERVICE', 'VOLUME_ACCESSIBILITY_CONSTRAINTS'];
    log.debug('getPluginCapabilities request: ' + caps.join(', '));
    cb(null, {
      capabilities: caps.map(c => {
        return { service: { type: c } };
      }),
    });
  }

  probe(_, cb) {
    log.debug(`probe request (ready=${this.ready})`);
    cb(null, { ready: { value: this.ready } });
  }

  //
  // Implementation of CSI controller methods
  //

  async controllerGetCapabilities(_, cb) {
    var caps = [
      'CREATE_DELETE_VOLUME',
      'PUBLISH_UNPUBLISH_VOLUME',
      'LIST_VOLUMES',
      'GET_CAPACITY',
    ];
    log.debug('get capabilities request: ' + caps.join(', '));
    cb(null, {
      capabilities: caps.map(c => {
        return { rpc: { type: c } };
      }),
    });
  }

  async createVolume(call, cb) {
    var args = call.request;

    log.debug(
      `Request to create volume "${args.name}" with size ` +
        args.capacityRange.requiredBytes +
        ` (limit ${args.capacityRange.limitBytes})`
    );

    if (args.volumeContentSource) {
      return cb(
        new GrpcError(
          grpc.status.INVALID_ARGUMENT,
          'Source for create volume is not supported'
        )
      );
    }
    // k8s uses names pvc-{uuid} and we use uuid further as ID in SPDK so we
    // must require it.
    let m = args.name.match(PVC_RE);
    if (!m) {
      return cb(
        new GrpcError(
          grpc.status.INVALID_ARGUMENT,
          'Expected the volume name in pvc-{uuid} format: ' + args.name
        )
      );
    }
    let uuid = m[1];
    try {
      checkCapabilities(args.volumeCapabilities);
    } catch (err) {
      return cb(err);
    }
    let mustNodes = [];
    let shouldNodes = [];

    if (args.accessibilityRequirements) {
      for (
        let i = 0;
        i < args.accessibilityRequirements.requisite.length;
        i++
      ) {
        let reqs = args.accessibilityRequirements.requisite[i];
        for (let key in reqs.segments) {
          // We are not able to evaluate any other topology requirements than
          // the hostname req. Reject all others.
          if (key != 'kubernetes.io/hostname') {
            return cb(
              new GrpcError(
                grpc.status.INVALID_ARGUMENT,
                'Volume topology other than hostname not supported'
              )
            );
          } else {
            mustNodes.push(reqs.segments[key]);
          }
        }
      }
      for (
        let i = 0;
        i < args.accessibilityRequirements.preferred.length;
        i++
      ) {
        let reqs = args.accessibilityRequirements.preferred[i];
        for (let key in reqs.segments) {
          // ignore others than hostname (it's only preferred)
          if (key == 'kubernetes.io/hostname') {
            shouldNodes.push(reqs.segments[key]);
          }
        }
      }
    }

    let count = args.parameters.repl;
    if (count) {
      count = parseInt(count);
      if (isNaN(count) || count <= 0) {
        return cb(
          new GrpcError(grpc.status.INVALID_ARGUMENT, 'Invalid replica count')
        );
      }
    } else {
      count = 1;
    }

    // create the volume
    var nexus;
    try {
      nexus = await this.commander.ensureVolume(uuid, {
        requiredBytes: args.capacityRange.requiredBytes,
        limitBytes: args.capacityRange.limitBytes,
        mustNodes,
        shouldNodes,
        count,
      });
    } catch (err) {
      if (err instanceof GrpcError) {
        cb(err);
      } else {
        cb(
          new GrpcError(
            grpc.status.UNKNOWN,
            `Unexpected error when creating volume "${args.name}": ` +
              err.toString()
          )
        );
      }
      return;
    }

    cb(null, {
      volume: {
        capacityBytes: nexus.size,
        volumeId: uuid,
        // enfore local access to the volume
        accessibleTopology: [
          {
            segments: { 'kubernetes.io/hostname': nexus.node },
          },
        ],
      },
    });
  }

  async deleteVolume(call, cb) {
    var args = call.request;

    log.debug(`Request to destroy volume "${args.volumeId}"`);

    let nexus = this.volumes.getNexus(args.volumeId);
    let replicaSet = this.volumes.getReplicaSet(args.volumeId);

    // try to destroy as much as we can - don't stop at the first error
    let errors = [];
    if (nexus) {
      try {
        await this.volumes.destroyNexus(nexus.node, args.volumeId);
      } catch (err) {
        errors.push(err);
      }
    }
    for (let i = 0; i < replicaSet.length; i++) {
      let r = replicaSet[i];
      try {
        await this.volumes.destroyReplica(r.node, r.uuid);
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) {
      let msg = `Failed to delete volume "${args.volumeId}": `;
      msg += errors.join('. ');
      cb(new GrpcError(grpc.status.INTERNAL, msg));
    } else {
      log.info(`Volume "${args.volumeId}" destroyed`);
      cb();
    }
  }

  async listVolumes(call, cb) {
    var args = call.request;
    var ctx = {};

    if (args.startingToken) {
      ctx = this.listContexts[args.startingToken];
      delete this.listContexts[args.startingToken];
      if (!ctx) {
        return cb(
          new GrpcError(
            grpc.status.INVALID_ARGUMENT,
            'Paging context for list volumes is gone'
          )
        );
      }
    } else {
      log.debug('Request to list volumes');
      ctx = {
        volumes: this.volumes
          .getNexus()
          .map(createK8sVolumeObject)
          .map(v => {
            return { volume: v };
          }),
      };
    }
    // default max entries
    if (!args.maxEntries) {
      args.maxEntries = 1000;
    }

    var entries = ctx.volumes.splice(0, args.maxEntries);

    // TODO: purge list contexts older than .. (1 min)
    if (ctx.volumes.length > 0) {
      let ctxId = this.nextListContextId++;
      this.listContexts[ctxId] = ctx;
      cb(null, {
        entries: entries,
        nextToken: ctxId.toString(),
      });
    } else {
      cb(null, { entries: entries });
    }
  }

  async controllerPublishVolume(call, cb) {
    var args = call.request;

    log.debug(
      `Request to publish volume "${args.volumeId}" on "${args.nodeId}"`
    );

    let nexus = this.volumes.getNexus(args.volumeId);
    if (!nexus) {
      return cb(
        new GrpcError(
          grpc.status.NOT_FOUND,
          `Volume "${args.volumeId}" does not exist`
        )
      );
    }
    var nodeId;
    try {
      nodeId = parseMayastorNodeId(args.nodeId);
    } catch (err) {
      return cb(err);
    }
    if (nodeId.node != nexus.node) {
      return cb(
        new GrpcError(
          grpc.status.INVALID_ARGUMENT,
          `Cannot publish the volume "${args.volumeId}" on a different ` +
            `node "${nodeId.node}" than it was created "${nexus.node}"`
        )
      );
    }
    if (args.readonly) {
      return cb(
        new GrpcError(
          grpc.status.INVALID_ARGUMENT,
          'readonly volumes are unsupported'
        )
      );
    }
    if (!args.volumeCapability) {
      return cb(
        new GrpcError(grpc.status.INVALID_ARGUMENT, 'missing volume capability')
      );
    }
    try {
      checkCapabilities([args.volumeCapability]);
    } catch (err) {
      return cb(err);
    }

    try {
      await this.volumes.publishNexus(nexus.uuid);
    } catch (err) {
      if (err.code === grpc.status.ALREADY_EXISTS) {
        log.debug(`Volume "${args.volumeId}" already published on this node`);
        cb(null, {});
      } else {
        cb(err);
      }
      return;
    }

    log.info(`Published volume "${args.volumeId}"`);
    cb(null, {});
  }

  async controllerUnpublishVolume(call, cb) {
    var args = call.request;

    log.debug(`Request to unpublish volume "${args.volumeId}"`);

    let nexus = this.volumes.getNexus(args.volumeId);
    if (!nexus) {
      return cb(
        new GrpcError(
          grpc.status.NOT_FOUND,
          `Volume "${args.volumeId}" does not exist`
        )
      );
    }
    var nodeId;
    try {
      nodeId = parseMayastorNodeId(args.nodeId);
    } catch (err) {
      return cb(err);
    }
    if (nodeId.node != nexus.node) {
      // we unpublish the volume anyway but at least we log a message
      log.warn(
        `Request to unpublish volume "${args.volumeId}" from a node ` +
          `"${nodeId.node}" when it was published on the node "${nexus.node}"`
      );
    }

    try {
      await this.volumes.unpublishNexus(nexus.uuid);
    } catch (err) {
      return cb(err);
    }
    log.info(`Unpublished volume "${args.volumeId}"`);
    cb(null, {});
  }

  async validateVolumeCapabilities(call, cb) {
    var args = call.request;

    log.debug(`Request to validate volume capabilities for "${args.volumeId}"`);

    if (!this.volumes.getNexus(args.volumeId)) {
      return cb(
        new GrpcError(
          grpc.status.NOT_FOUND,
          `Volume "${args.volumeId}" does not exist`
        )
      );
    }
    let caps = args.volumeCapabilities.filter(
      cap => cap.accessMode.mode == 'SINGLE_NODE_WRITER'
    );
    let resp = {};
    if (caps.length > 0) {
      resp.confirmed = { volumeCapabilities: caps };
    } else {
      resp.message = 'The only supported capability is SINGLE_NODE_WRITER';
    }
    cb(null, resp);
  }

  // We understand just one topology segment type and that is hostname.
  // So if it is specified we return capacity of storage pools on the node
  // or capacity of all pools in the cluster.
  // The value we return is actual (not cached).
  //
  // XXX Is the caller interested in total capacity (sum of all pools) or
  // a capacity usable by a single volume?
  async getCapacity(call, cb) {
    var args = call.request;

    if (args.volumeCapabilities) {
      try {
        checkCapabilities(args.volumeCapabilities);
      } catch (err) {
        return cb(err);
      }
    }
    if (args.accessibleTopology) {
      for (let key in args.accessibleTopology.segments) {
        if (key == 'kubernetes.io/hostname') {
          let nodeName = args.accessibleTopology.segments[key];
          let capacity = 0;
          await this.pools.syncNode(nodeName);
          // jshint ignore:start
          capacity = this.pools
            .get()
            .filter(p => p.node == nodeName)
            .reduce((acc, p) => {
              return isPoolAccessible(p) ? acc + (p.capacity - p.used) : 0;
            }, 0);
          // jshint ignore:end
          log.debug(`Get capacity of node "${nodeName}": ${capacity} bytes`);
          return cb(null, { availableCapacity: capacity });
        }
      }
    }

    // refresh pool info from all nodes
    await this.pools.syncNode();
    let capacity = this.pools
      .get()
      .filter(p => isPoolAccessible(p))
      .reduce((acc, p) => {
        return acc + (p.capacity - p.used);
      }, 0);

    log.debug(`Get total capacity: ${capacity} bytes`);
    cb(null, { availableCapacity: capacity });
  }
}

module.exports = {
  CsiServer,
  // the rest is exported for tests
  csi,
  GrpcError,
};
