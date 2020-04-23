// Unit tests for rebuild tasks

'use strict';

const { createClient } = require('grpc-kit');
const async = require('async');
const fs = require('fs');
const common = require('./test_common');
const path = require('path');
const assert = require('chai').assert;
const sleep = require('sleep-promise');
const grpc = require('grpc-uds');
const grpc_promise = require('grpc-promise');
const protoLoader = require('@grpc/proto-loader');

// backend file for aio bdev
const child1 = '/tmp/child1';
const child2 = '/tmp/child2';
// 64MB is the size of nexus and replicas
const diskSize = 64 * 1024 * 1024;
// nexus UUID
const UUID = 'dbe4d7eb-118a-4d15-b789-a18d9af6ff21';
// external IP address detected by common lib
const externIp = common.getMyIp();

// Instead of using mayastor grpc methods to create replicas we use a config
// file to create them. Advantage is that we don't depend on bugs in replica
// code (the nexus tests are more independent). Disadvantage is that we don't
// test the nexus with implementation of replicas which are used in the
// production.
const configNexus = `
[Malloc]
  NumberOfLuns 2
  LunSizeInMB  64
  BlockSize    4096

[iSCSI]
  NodeBase "iqn.2019-05.io.openebs"
  # Socket I/O timeout sec. (0 is infinite)
  Timeout 30
  DiscoveryAuthMethod None
  DefaultTime2Wait 2
  DefaultTime2Retain 60
  ImmediateData Yes
  ErrorRecoveryLevel 0
  # Reduce mem requirements for iSCSI
  MaxSessions 1
  MaxConnectionsPerSession 1

[PortalGroup1]
  Portal GR1 0.0.0.0:3261

[InitiatorGroup1]
  InitiatorName Any
  Netmask ${externIp}/24

[TargetNode0]
  TargetName "iqn.2019-05.io.openebs:disk1"
  TargetAlias "Backend Malloc1"
  Mapping PortalGroup1 InitiatorGroup1
  AuthMethod None
  UseDigest Auto
  LUN0 Malloc1
  QueueDepth 1
`;

// The config just for nvmf target which cannot run in the same process as
// the nvmf initiator (SPDK limitation).
const configNvmfTarget = `
[Malloc]
  NumberOfLuns 1
  LunSizeInMB  64
  BlockSize    4096

[Nvmf]
  AcceptorPollRate 10000
  ConnectionScheduler RoundRobin

[Transport]
  Type TCP
  # reduce memory requirements
  NumSharedBuffers 32

[Subsystem1]
  NQN nqn.2019-05.io.openebs:disk2
  Listen TCP 127.0.0.1:8420
  AllowAnyHost Yes
  SN MAYASTOR0000000001
  MN NEXUSController1
  MaxNamespaces 1
  Namespace Malloc0 1

# although not used we still have to reduce mem requirements for iSCSI
[iSCSI]
  MaxSessions 1
  MaxConnectionsPerSession 1
`;

const nexusArgs = {
  uuid: UUID,
  size: 131072,
  children: [`aio:///${child1}?blk_size=4096`]
};

const rebuildArgs = {
  uuid: UUID,
  uri: `aio:///${child2}?blk_size=4096`
};

function createGrpcClient () {
  const PROTO_PATH = __dirname + '/../rpc/proto/mayastor_service.proto';

  // Load mayastor proto file with mayastor service
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true
  });

  const mayastor = grpc.loadPackageDefinition(packageDefinition)
    .mayastor_service;

  const client = new mayastor.Mayastor(
    common.grpc_endpoint,
    grpc.credentials.createInsecure()
  );
  grpc_promise.promisifyAll(client);
  return client;
}

describe('rebuild tests', function () {
  var client;

  this.timeout(10000); // for network tests we need long timeouts

  var ObjectType = {
    NEXUS: 0,
    SOURCE_CHILD: 1,
    DESTINATION_CHILD: 2
  };

  async function checkState (childType, expectedState) {
    const res = await client.listNexus().sendMessage(rebuildArgs);
    assert.lengthOf(res.nexusList, 1);

    const nexus = res.nexusList[0];
    assert.equal(nexus.uuid, UUID);

    if (childType == ObjectType.NEXUS) {
      assert.equal(nexus.state, expectedState);
    } else if (childType == ObjectType.SOURCE_CHILD) {
      assert.equal(nexus.children[0].state, expectedState);
    } else if (childType == ObjectType.DESTINATION_CHILD) {
      assert.equal(nexus.children[1].state, expectedState);
    }
  }

  async function checkNumRebuilds (expected) {
    const res = await client.listNexus().sendMessage(rebuildArgs);
    assert.lengthOf(res.nexusList, 1);

    const nexus = res.nexusList[0];
    assert.equal(nexus.uuid, UUID);
    assert.equal(nexus.rebuilds, expected);
  }

  function pingMayastor (done) {
    // use harmless method to test if the mayastor is up and running
    client
      .listPools()
      .sendMessage()
      .then(() => {
        done();
      })
      .catch((err) => {
        return done(err);
      });
  }

  before((done) => {
    client = createGrpcClient();
    if (!client) {
      return done(new Error('Failed to initialize grpc client'));
    }

    async.series(
      [
        common.ensureNbdWritable,
        (next) => {
          fs.writeFile(child1, '', next);
        },
        (next) => {
          fs.truncate(child1, diskSize, next);
        },
        (next) => {
          fs.writeFile(child2, '', next);
        },
        (next) => {
          fs.truncate(child2, diskSize, next);
        },
        (next) => {
          common.startMayastor(configNexus, ['-r', common.SOCK, '-s', 386]);
          common.startMayastorGrpc();
          common.waitFor((pingDone) => {
            pingMayastor(pingDone);
          }, next);
        },
        (next) => {
          client
            .createNexus()
            .sendMessage(nexusArgs)
            .then(() => {
              next();
            })
            .catch(done);
        }
      ],
      done
    );
  });

  after((done) => {
    async.series(
      [
        common.stopAll,
        common.restoreNbdPerms,
        (next) => {
          fs.unlink(child1, (err) => next());
        },
        (next) => {
          fs.unlink(child2, (err) => next());
        },
        (next) => {
          client
            .destroyNexus()
            .sendMessage({ uuid: UUID })
            .then(() => {
              next();
            })
            .catch((err) => {
              done();
            })
            .catch(done);
        }
      ],
      (err) => {
        if (client != null) {
          client.close();
        }
        done(err);
      }
    );
  });

  describe('running rebuild', function () {
    beforeEach(async () => {
      await client.addChildNexus().sendMessage(rebuildArgs);
      await client.startRebuild().sendMessage(rebuildArgs);
    });

    afterEach(async () => {
      await client.stopRebuild().sendMessage(rebuildArgs);
      await client.removeChildNexus().sendMessage(rebuildArgs);
    });

    it('check nexus state', async () => {
      await checkState(ObjectType.NEXUS, 'degraded');
    });

    it('check source state', async () => {
      await checkState(ObjectType.SOURCE_CHILD, 'open');
    });

    it('check destination state', async () => {
      await checkState(ObjectType.DESTINATION_CHILD, 'faulted');
    });
  });

  describe('stopping rebuild', function () {
    beforeEach(async () => {
      await client.addChildNexus().sendMessage(rebuildArgs);
      await client.startRebuild().sendMessage(rebuildArgs);
      await client.stopRebuild().sendMessage(rebuildArgs);
      // TODO: Check for rebuild stop rather than sleeping
      await sleep(1000); // Give time for the rebuild to stop
    });

    afterEach(async () => {
      await client.removeChildNexus().sendMessage(rebuildArgs);
    });

    it('check nexus state', async () => {
      await checkState(ObjectType.NEXUS, 'degraded');
    });

    it('check source state', async () => {
      await checkState(ObjectType.SOURCE_CHILD, 'open');
    });

    it('check destination state', async () => {
      await checkState(ObjectType.DESTINATION_CHILD, 'faulted');
    });

    it('get rebuild state', async (done) => {
      // Expect to fail to get rebuild state because
      // after stopping there is no rebuild task
      client
        .getRebuildState()
        .sendMessage(rebuildArgs)
        .then(() => {
          done(new Error('Expected to fail to get rebuild state.'));
        })
        .catch((err) => {
          assert.isDefined(err);
        })
        .catch(done);
      done();
    });

    it('get number of rebuilds', async () => {
      await checkNumRebuilds('0');
    });
  });
});
