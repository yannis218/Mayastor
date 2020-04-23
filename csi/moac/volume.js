// Volume object abstracts user from volume components nexus and
// replicas and implements algorithms for volume recovery.

'use strict';

const _ = require('lodash');
const assert = require('assert');
const log = require('./logger').Logger('volume');
const { GrpcCode, GrpcError } = require('./grpc_client');

// Abstraction of the volume. It is an abstract object which consists of
// physical entities nexus and replicas. It provides high level methods
// for doing operations on the volume as well as recovery algorithms for
// maintaining desired redundancy.
class Volume {
  // Construct a volume object with given uuid.
  //
  // @params {string}   uuid                 ID of the volume.
  // @params {object}   registry             Registry object.
  // @params {object}   spec                 Volume parameters.
  // @params {number}   spec.replicaCount    Number of desired replicas.
  // @params {string[]} spec.preferredNodes  Nodes to prefer for scheduling replicas.
  // @params {string[]} spec.requiredNodes   Replicas must be on these nodes.
  // @params {number}   spec.requiredBytes   The volume must have at least this size.
  // @params {number}   spec.limitBytes      The volume should not be bigger than this.
  //
  constructor (uuid, registry, spec) {
    assert(spec);
    // specification of the volume
    this.uuid = uuid;
    this.registry = registry;
    this.replicaCount = spec.replicaCount || 1;
    this.preferredNodes = _.clone(spec.preferredNodes || []).sort();
    this.requiredNodes = _.clone(spec.requiredNodes || []).sort();
    this.requiredBytes = spec.requiredBytes;
    this.limitBytes = spec.limitBytes;
    this.size = 0;
    // state variables of the volume
    this.nexus = null;
    this.replicas = {}; // replicas indexed by node name
    this.state = 'PENDING';
    this.reason = 'The volume is being created';
  }

  // Stringify volume
  toString () {
    return this.uuid;
  }

  // Get the size of the volume.
  getSize () {
    return this.size;
  }

  // Get the node which the volume is accessible from
  // (currently that is where the nexus is).
  getNodeName () {
    return this.nexus ? this.nexus.node.name : '';
  }

  // Publish the volume. That means make it accessible through a block device.
  // @params {string}   protocol      The nexus share protocol.
  async publish (protocol) {
    if (this.nexus) {
      await this.nexus.publish(protocol);
    } else {
      throw new GrpcError(
        GrpcCode.INTERNAL,
        'Cannot publish a volume without nexus'
      );
    }
  }

  // Undo publish operation on the volume.
  async unpublish () {
    if (this.nexus) {
      await this.nexus.unpublish();
    } else {
      throw new GrpcError(
        GrpcCode.INTERNAL,
        'Cannot unpublish a volume without nexus'
      );
    }
  }

  // Delete nexus and destroy all replicas of the volume.
  async destroy () {
    if (this.nexus) {
      await this.nexus.destroy();
    }
    const promises = Object.values(this.replicas).map((replica) =>
      replica.destroy()
    );
    await Promise.all(promises);
  }

  // Ensure that configuration of a volume is as it should be. Create whatever
  // component is missing and try to fix all discrepancies between desired
  // state and reality.
  //
  // TODO: there is much to improve in this func but we focus just on simple use
  // cases as of now.
  async ensure () {
    log.debug(`Ensuring state of volume "${this}"`);

    // Ensure there is sufficient number of replicas for the volume.
    // TODO: take replica state into account
    const newReplicaCount = this.replicaCount - Object.keys(this.replicas).length;
    if (newReplicaCount > 0) {
      // create more replicas if higher replication factor is desired
      await this._createReplicas(newReplicaCount);
    }

    // Ensure replicas can be accessed from nexus. Set share protocols.
    const replicaSet = await this._ensureReplicaShareProtocols();

    // Update child devs of existing nexus or create a new one if it is missing
    await this._ensureNexus(replicaSet);

    // Now when nexus has been updated we can remove excessive replicas
    // (those which are not recorded in the nexus)
    const childrenUris = this.nexus.children.map((ch) => ch.uri);
    const promises = Object.values(this.replicas)
      .filter((r) => childrenUris.indexOf(r.uri) < 0)
      .map((r) => r.destroy());
    try {
      await Promise.all(promises);
    } catch (err) {
      // we don't treat the error as fatal
      log.error(`Failed to destroy redundant replicas of volume "${this}"`);
    }
  }

  // Update child devices of existing nexus or create a new nexus if it does not
  // exist.
  //
  // @param {object[]} replicas   Replicas that should be used for child bdevs of nexus.
  //
  async _ensureNexus (replicas) {
    const nexus = this.nexus;
    if (!nexus) {
      // create a new nexus
      const localReplica = Object.values(this.replicas).find(
        (r) => r.share == 'REPLICA_NONE'
      );
      if (!localReplica) {
        // should not happen but who knows ..
        throw new GrpcError(
          GrpcCode.INTERNAL,
          'Cannot create nexus if none of the replicas is local'
        );
      }
      this.nexus = await localReplica.pool.node.createNexus(
        this.uuid,
        this.size,
        Object.values(replicas)
      );
      log.info(`Volume "${this}" with size ${this.size} was created`);
    } else {
      // TODO: Switching order might be more safe (remove and add uri)
      const oldUris = nexus.children.map((ch) => ch.uri).sort();
      const newUris = _.map(replicas, 'uri').sort();
      // remove children which should not be in the nexus
      for (let i = 0; i < oldUris.length; i++) {
        const uri = oldUris[i];
        const idx = newUris.indexOf(uri);
        if (idx < 0) {
          // jshint ignore:start
          const replica = Object.values(this.replicas).find((r) => r.uri == uri);
          if (replica) {
            try {
              await nexus.removeReplica(replica);
            } catch (err) {
              // non-fatal failure
              log.warn(
                `Failed to remove child "${uri}" of nexus "${nexus}": ${err}`
              );
            }
          }
          // jshint ignore:end
        } else {
          newUris.splice(idx, 1);
        }
      }
      // add children which are not there yet
      for (let i = 0; i < newUris.length; i++) {
        const uri = newUris[i];
        // jshint ignore:start
        const replica = Object.values(this.replicas).find((r) => r.uri == uri);
        if (replica) {
          try {
            await nexus.addReplica(replica);
          } catch (err) {
            throw new GrpcError(
              GrpcCode.INTERNAL,
              `Failed to add child "${uri}" to nexus "${nexus}": ${err}`
            );
          }
        }
        // jshint ignore:end
      }
    }
  }

  // Adjust replica count for the volume to required count.
  //
  // TODO: Take into account state of replicas.
  //
  // @param {number} newCount   Number of new replicas to create.
  //
  async _createReplicas (count) {
    let pools = this.registry.choosePools(
      this.requiredBytes,
      this.requiredNodes,
      this.preferredNodes
    );
    // remove pools that are already used by existing replicas
    const usedNodes = Object.keys(this.replicas);
    pools = pools.filter((p) => usedNodes.indexOf(p.node.name) < 0);
    if (pools.length < count) {
      log.error(
        `No suitable pool(s) for volume "${this}" with capacity ` +
          `${this.requiredBytes} and replica count ${this.replicaCount}`
      );
      throw new GrpcError(
        GrpcCode.RESOURCE_EXHAUSTED,
        'Cannot find suitable storage pool(s) for the volume'
      );
    }

    // Calculate the size of the volume if not given precisely. The size
    // of the smallest pool is the safe choice though a bit too
    // conservative (TODO).
    if (!this.size) {
      this.size = Math.min(
        pools.reduce(
          (acc, pool) => Math.min(acc, pool.freeBytes()),
          Number.MAX_SAFE_INTEGER
        ),
        this.limitBytes || this.requiredBytes
      );
    }

    // We record all failures as we try to create the replica on available
    // pools to return them to the user at the end if we ultimately fail.
    const errors = [];
    // try one pool after another until success
    for (let i = 0; i < pools.length && count > 0; i++) {
      const pool = pools[i];

      try {
        // this will add the replica to the cache if successful
        await pool.createReplica(this.uuid, this.size);
      } catch (err) {
        log.error(err.message);
        errors.push(err.message);
        continue;
      }
      count--;
    }
    // check if we created enough replicas
    if (count > 0) {
      let msg = `Failed to create required number of replicas for volume "${this}": `;
      msg += errors.join('. ');
      throw new GrpcError(GrpcCode.INTERNAL, msg);
    }
  }

  // Get list of replicas for this volume sorted from the most to the
  // least preferred.
  //
  // @returns {object[]}  List of replicas sorted by preference (the most first).
  //
  _prioritizeReplicas () {
    const self = this;
    return Object.values(self.replicas).sort(
      (a, b) => self._scoreReplica(b) - self._scoreReplica(a)
    );
  }

  // Assign score to a replica based on certain criteria. The higher the better.
  //
  // @param   {object} replica  Replica object.
  // @returns {number} Score from 0 to 18.
  //
  _scoreReplica (replica) {
    let score = 0;
    const node = replica.pool.node;

    // criteria #1: must be on the required nodes if set
    if (
      this.requiredNodes.length > 0 &&
      this.requiredNodes.indexOf(node.name) >= 0
    ) {
      score += 10;
    }
    // criteria #2: replica should be online
    if (replica.state == 'ONLINE') {
      score += 5;
    }
    // criteria #2: would be nice to run on preferred node
    if (
      this.preferredNodes.length > 0 &&
      this.preferredNodes.indexOf(node.name) >= 0
    ) {
      score += 2;
    }
    // criteria #3: local IO from nexus is certainly an advantage
    if (this.nexus && node == this.nexus.node) {
      score += 1;
    }

    // TODO: Score the replica based on the pool parameters.
    //   I.e. the replica on a less busy pool would have higher score.
    return score;
  }

  // Share replicas as appropriate to allow access from the nexus and return
  // just replicas that should be used for the nexus (excessive replicas will
  // be trimmed).
  //
  // @returns {object[]} Replicas that should be used for nexus sorted by preference.
  //
  async _ensureReplicaShareProtocols () {
    // If nexus does not exist it will be created on the same node as the most
    // preferred replica.
    const replicaSet = this._prioritizeReplicas();
    if (replicaSet.length == 0) {
      throw new GrpcError(
        GrpcCode.INTERNAL,
        `There are no replicas for volume "${this}"`
      );
    }
    replicaSet.splice(this.replicaCount);

    const nexusNode = this.nexus ? this.nexus.node : replicaSet[0].pool.node;

    for (let i = 0; i < replicaSet.length; i++) {
      const replica = replicaSet[i];
      let share;
      const local = replica.pool.node == nexusNode;
      // make sure that replica which is local to the nexus is accessed locally
      if (local && replica.share != 'REPLICA_NONE') {
        share = 'REPLICA_NONE';
      } else if (!local && replica.share == 'REPLICA_NONE') {
        // make sure that replica which is remote to nexus can be accessed
        share = 'REPLICA_NVMF';
      }
      if (share) {
        try {
          await replica.setShare(share);
        } catch (err) {
          throw new GrpcError(
            GrpcCode.INTERNAL,
            `Failed to set share pcol to ${share} for replica "${replica}": ${err}`
          );
        }
        log.info(`Share protocol for replica "${replica}" set to ${share}`);
      }
    }
    return replicaSet;
  }

  // Update parameters of the volume.
  //
  // Throw exception if size of volume is changed in an incompatible way
  // (unsupported).
  //
  // @params {object}   spec                 Volume parameters.
  // @params {number}   spec.replicaCount    Number of desired replicas.
  // @params {string[]} spec.preferredNodes  Nodes to prefer for scheduling replicas.
  // @params {string[]} spec.requiredNodes   Replicas must be on these nodes.
  // @params {number}   spec.requiredBytes   The volume must have at least this size.
  // @params {number}   spec.limitBytes      The volume should not be bigger than this.
  // @returns {boolean} True if the volume spec has changed, false otherwise.
  //
  update (spec) {
    var changed = false;

    if (this.size < spec.requiredBytes) {
      throw new GrpcError(
        GrpcCode.INVALID_ARGUMENT,
        `Extending the volume "${this}" is not supported`
      );
    }
    if (spec.limitBytes && this.size > spec.limitBytes) {
      throw new GrpcError(
        GrpcCode.INVALID_ARGUMENT,
        `Shrinking the volume "${this}" is not supported`
      );
    }

    if (this.replicaCount != spec.replicaCount) {
      this.replicaCount = spec.replicaCount;
      changed = true;
    }
    const preferredNodes = _.clone(spec.preferredNodes || []).sort();
    if (!_.isEqual(this.preferredNodes, preferredNodes)) {
      this.preferredNodes = preferredNodes;
      changed = true;
    }
    const requiredNodes = _.clone(spec.requiredNodes || []).sort();
    if (!_.isEqual(this.requiredNodes, requiredNodes)) {
      this.requiredNodes = requiredNodes;
      changed = true;
    }
    if (this.requiredBytes != spec.requiredBytes) {
      this.requiredBytes = spec.requiredBytes;
      changed = true;
    }
    if (this.limitBytes != spec.limitBytes) {
      this.limitBytes = spec.limitBytes;
      changed = true;
    }
    return changed;
  }

  //
  // Handlers for the events from node registry follow
  //

  // Add new replica to the volume.
  newReplica (replica) {
    assert(replica.uuid == this.uuid);
    const nodeName = replica.pool.node.name;
    if (this.replicas[nodeName]) {
      log.warn(
        `Trying to add the same replica "${replica}" to the volume twice`
      );
    } else {
      // TODO: scale down if n > replica count
      // TODO: update the nexus if necessary
      log.debug(`Replica "${replica}" attached to the volume`);
      this.replicas[nodeName] = replica;
    }
  }

  // Modify replica in the volume.
  modReplica (replica) {
    assert(replica.uuid == this.uuid);
    const nodeName = replica.pool.node.name;
    if (!this.replicas[nodeName]) {
      log.warn(`Modified replica "${replica}" does not belong to the volume`);
    } else {
      // TODO: check replica count in regard to a state which might have changed
      // TODO: update the nexus if necessary
      assert(this.replicas[nodeName] == replica);
    }
  }

  // Delete replica in the volume.
  delReplica (replica) {
    assert(replica.uuid == this.uuid);
    const nodeName = replica.pool.node.name;
    if (!this.replicas[nodeName]) {
      log.warn(`Deleted replica "${replica}" does not belong to the volume`);
    } else {
      // TODO: check replica count
      // TODO: update the nexus if necessary
      log.debug(`Replica "${replica}" detached from the volume`);
      assert(this.replicas[nodeName] == replica);
      delete this.replicas[nodeName];
    }
  }

  // Assign nexus to the volume.
  newNexus (nexus) {
    assert(nexus.uuid == this.uuid);
    if (this.nexus) {
      log.warn(`Trying to add nexus "${nexus}" to the volume twice`);
    } else {
      // TODO: check consistency of replicas
      // TODO: check replica count
      // TODO: update the nexus if necessary
      // TODO: figure out the exact relation between nexus and vol state
      log.debug(`Nexus "${nexus}" attached to the volume`);
      this.nexus = nexus;
      this.state = nexus.state;
      this.reason = '';
    }
  }

  // Modify nexus in the volume.
  modNexus (nexus) {
    assert(nexus.uuid == this.uuid);
    if (!this.nexus) {
      log.warn(`Modified nexus "${nexus}" does not belong to the volume`);
    } else {
      // TODO: check children and their state and scale up/down as appropriate
      assert(this.nexus == nexus);
      this.state = nexus.state;
      this.reason = '';
    }
  }

  // Delete nexus in the volume.
  delNexus (nexus) {
    assert(nexus.uuid == this.uuid);
    if (!this.nexus) {
      log.warn(`Deleted nexus "${nexus}" does not belong to the volume`);
    } else {
      log.debug(`Nexus "${nexus}" detached from the volume`);
      assert(this.nexus == nexus);
      this.nexus = null;
      this.state = 'PENDING';
      this.reason = 'The volume is missing nexus';
    }
  }
}

module.exports = Volume;
