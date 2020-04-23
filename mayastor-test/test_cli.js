'use strict';

// Unit tests for mayastor CLI (mayastor-client).
//
// The tests don't depend on running mayastor server, so that CLI can
// be tested independetly on other components. The price we pay for
// the isolation and flexibility is that we have to use grpc mock
// server to fake the server and responses.

const assert = require('chai').assert;
const async = require('async');
const exec = require('child_process').exec;
const path = require('path');
const util = require('util');
const { createMockServer } = require('grpc-mock');

const EGRESS_PORT = 50051;
const POOL = 'tpool';
const DISK = '/dev/disk';
const UUID = '753b391c-9b04-4ce3-9c74-9d949152e547';
const UUID1 = '753b391c-9b04-4ce3-9c74-9d949152e541';
const UUID2 = '753b391c-9b04-4ce3-9c74-9d949152e542';
const UUID3 = '753b391c-9b04-4ce3-9c74-9d949152e543';
const CLIENT_CMD = path.join(
  __dirname,
  '..',
  'target',
  'debug',
  'mayastor-client'
);
const EGRESS_CMD = CLIENT_CMD + ' -p ' + EGRESS_PORT;

var mayastorMockServer;

// Here we initialize gRPC mock server with predefined replies for requests
// we use in the tests below. Note that the request must exactly match the
// object specified in rules. If not, the server does not reply and the client
// will hang.
function runMockServer (rules) {
  mayastorMockServer = createMockServer({
    protoPath: path.join(
      __dirname,
      '..',
      'rpc',
      'proto',
      'mayastor_service.proto'
    ),
    packageName: 'mayastor_service',
    serviceName: 'Mayastor',
    rules: rules
  });

  mayastorMockServer.listen('127.0.0.1:' + EGRESS_PORT);
}

describe('cli', function () {
  describe('success', function () {
    before(() => {
      process.env.RUST_BACKTRACE = '1';
      runMockServer([
        {
          method: 'CreatePool',
          input: {
            name: POOL,
            disks: [DISK],
            blockSize: 512
          },
          output: {}
        },
        {
          method: 'DestroyPool',
          input: {
            name: POOL
          },
          output: {}
        },
        {
          method: 'ListPools',
          input: {},
          output: {
            pools: [
              {
                name: POOL + '1',
                disks: [DISK + '1'],
                state: 0,
                capacity: 100 * (1024 * 1024),
                used: 50 * (1024 * 1024)
              },
              {
                name: POOL + '2',
                disks: [DISK + '2a', DISK + '2b'],
                state: 1,
                capacity: 1000 * (1024 * 1024),
                used: 99 * (1024 * 1024)
              }
            ]
          }
        },
        {
          method: 'CreateReplica',
          input: {
            uuid: UUID,
            pool: POOL,
            size: { low: 1000 * (1024 * 1024), high: 0, unsigned: true },
            thin: true,
            share: 1
          },
          output: {
            uri: 'nvmf://192.168.0.1:4444/' + UUID
          }
        },
        {
          method: 'DestroyReplica',
          input: {
            uuid: UUID
          },
          output: {}
        },
        {
          method: 'ShareReplica',
          input: {
            uuid: UUID,
            share: 2
          },
          output: {
            uri: 'iscsi://192.168.0.1:4444/' + UUID
          }
        },
        {
          method: 'ListReplicas',
          input: {},
          output: {
            replicas: [
              {
                uuid: UUID1,
                pool: POOL,
                thin: true,
                share: 0,
                uri: 'bdev:///' + UUID,
                size: 10000 * (1024 * 1024)
              },
              {
                uuid: UUID2,
                pool: POOL,
                thin: false,
                share: 1,
                uri: 'nvmf://192.168.0.1:4444/' + UUID,
                size: 10 * (1024 * 1024)
              },
              {
                uuid: UUID3,
                pool: POOL,
                thin: false,
                share: 2,
                uri: 'iscsi://192.168.0.1:4444/' + UUID,
                size: 10 * (1024 * 1024)
              }
            ]
          }
        },
        {
          method: 'StatReplicas',
          input: {},
          output: {
            replicas: [
              {
                uuid: UUID1,
                pool: POOL,
                stats: {
                  numReadOps: { low: 10000, high: 0, unsigned: true },
                  numWriteOps: { low: 0, high: 0, unsigned: true },
                  bytesRead: { low: 10000000, high: 0, unsigned: true },
                  bytesWritten: { low: 0, high: 0, unsigned: true }
                }
              },
              {
                uuid: UUID2,
                pool: POOL,
                stats: {
                  numReadOps: { low: 1, high: 0, unsigned: true },
                  numWriteOps: { low: 200000, high: 0, unsigned: true },
                  bytesRead: { low: 1000, high: 0, unsigned: true },
                  bytesWritten: { low: 200000000, high: 0, unsigned: true }
                }
              }
            ]
          }
        }
      ]);
    });

    after(() => {
      if (mayastorMockServer) {
        mayastorMockServer.close(true);
      }
    });

    it('should create a pool', function (done) {
      const cmd = util.format(
        '%s pool create -b 512 %s %s',
        EGRESS_CMD,
        POOL,
        DISK
      );

      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          return done(err);
        }
        assert.isEmpty(stderr);
        assert.isEmpty(stdout);
        done();
      });
    });

    it('should list pools', function (done) {
      const cmd = util.format('%s -q pool list', EGRESS_CMD);

      exec(cmd, (err, stdout, stderr) => {
        const pools = [];

        if (err) {
          return done(err);
        }
        assert.isEmpty(stderr);

        stdout.split('\n').forEach((line) => {
          const parts = line
            .trim()
            .split(' ')
            .filter((s) => s.length != 0);

          if (parts.length <= 1) {
            return;
          }

          pools.push({
            name: parts[0],
            state: parts[1],
            capacity: parts[2],
            capacity_unit: parts[3],
            used: parts[4],
            used_unit: parts[5],
            disks: parts.slice(6)
          });
        });

        assert.lengthOf(pools, 2);

        assert.equal(pools[0].name, POOL + '1');
        assert.equal(pools[0].state, 'online');
        assert.equal(pools[0].capacity, '100.0');
        assert.equal(pools[0].capacity_unit, 'MiB');
        assert.equal(pools[0].used, '50.0');
        assert.equal(pools[0].used_unit, 'MiB');
        assert.deepEqual(pools[0].disks, [DISK + '1']);

        assert.equal(pools[1].name, POOL + '2');
        assert.equal(pools[1].state, 'degraded');
        assert.equal(pools[1].capacity, '1.0');
        assert.equal(pools[1].capacity_unit, 'GiB');
        assert.equal(pools[1].used, '99.0');
        assert.equal(pools[1].used_unit, 'MiB');
        assert.deepEqual(pools[1].disks, [DISK + '2a', DISK + '2b']);

        done();
      });
    });

    it('should destroy a pool', function (done) {
      const cmd = util.format('%s pool destroy %s', EGRESS_CMD, POOL);

      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          return done(err);
        }
        assert.isEmpty(stderr);
        assert.isEmpty(stdout);
        done();
      });
    });

    it('should create a replica', function (done) {
      const cmd = util.format(
        '%s replica create %s %s --size=1000 --thin --protocol=nvmf',
        EGRESS_CMD,
        POOL,
        UUID
      );

      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          return done(err);
        }
        assert.isEmpty(stderr);
        assert.match(stdout, /^nvmf:\/\//);
        done();
      });
    });

    it('should share the replica', function (done) {
      const cmd = util.format('%s replica share %s iscsi', EGRESS_CMD, UUID);

      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          return done(err);
        }
        assert.isEmpty(stderr);
        assert.match(stdout, /^iscsi:\/\//);
        done();
      });
    });

    it('should list replicas', function (done) {
      const cmd = util.format('%s -q replica list', EGRESS_CMD);

      exec(cmd, (err, stdout, stderr) => {
        const repls = [];

        if (err) {
          return done(err);
        }
        assert.isEmpty(stderr);

        stdout.split('\n').forEach((line) => {
          const parts = line
            .trim()
            .split(' ')
            .filter((s) => s.length != 0);

          if (parts.length <= 1) {
            return;
          }

          repls.push({
            pool: parts[0],
            name: parts[1],
            thin: parts[2],
            share: parts[3],
            size: parts[4],
            size_unit: parts[5],
            uri: parts[6]
          });
        });

        assert.lengthOf(repls, 3);

        assert.equal(repls[0].name, UUID1);
        assert.equal(repls[0].pool, POOL);
        assert.equal(repls[0].thin, 'true');
        assert.equal(repls[0].share, 'none');
        assert.equal(repls[0].size, '9.8'); // 10000MiB -> 9.8 GiB
        assert.equal(repls[0].size_unit, 'GiB');
        assert.match(repls[0].uri, /^bdev:\/\/\/\d+/);

        assert.equal(repls[1].name, UUID2);
        assert.equal(repls[1].pool, POOL);
        assert.equal(repls[1].thin, 'false');
        assert.equal(repls[1].share, 'nvmf');
        assert.equal(repls[1].size, '10.0');
        assert.equal(repls[1].size_unit, 'MiB');
        assert.match(repls[1].uri, /^nvmf:\/\/\d+/);

        assert.equal(repls[2].name, UUID3);
        assert.equal(repls[2].pool, POOL);
        assert.equal(repls[2].thin, 'false');
        assert.equal(repls[2].share, 'iscsi');
        assert.equal(repls[2].size, '10.0');
        assert.equal(repls[2].size_unit, 'MiB');
        assert.match(repls[2].uri, /^iscsi:\/\/\d+/);

        done();
      });
    });

    it('should stat replicas', function (done) {
      const cmd = util.format('%s -q replica stats', EGRESS_CMD);

      exec(cmd, (err, stdout, stderr) => {
        const repls = [];

        if (err) {
          return done(err);
        }
        assert.isEmpty(stderr);

        stdout.split('\n').forEach((line) => {
          const parts = line
            .trim()
            .split(' ')
            .filter((s) => s.length != 0);

          if (parts.length <= 1) {
            return;
          }

          repls.push({
            pool: parts[0],
            name: parts[1],
            num_read_ops: parts[2],
            num_write_ops: parts[3],
            bytes_read: parts[4],
            bytes_written: parts[5]
          });
        });

        assert.lengthOf(repls, 2);

        assert.equal(repls[0].name, UUID1);
        assert.equal(repls[0].pool, POOL);
        assert.equal(repls[0].num_read_ops, '10000');
        assert.equal(repls[0].num_write_ops, '0');
        assert.equal(repls[0].bytes_read, '10000000');
        assert.equal(repls[0].bytes_written, '0');

        assert.equal(repls[1].name, UUID2);
        assert.equal(repls[1].pool, POOL);
        assert.equal(repls[1].num_read_ops, '1');
        assert.equal(repls[1].num_write_ops, '200000');
        assert.equal(repls[1].bytes_read, '1000');
        assert.equal(repls[1].bytes_written, '200000000');

        done();
      });
    });

    it('should destroy a replica', function (done) {
      const cmd = util.format('%s replica destroy %s', EGRESS_CMD, UUID);

      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          return done(err);
        }
        assert.isEmpty(stderr);
        assert.isEmpty(stdout);
        done();
      });
    });
  });

  // these cases test typical failures which might happen
  describe('failures', function () {
    before(() => {
      runMockServer([
        {
          method: 'CreatePool',
          input: {
            name: POOL,
            disks: [DISK]
          },
          error: {
            code: 6, // ALREADY_EXISTS
            message: 'Pool already exists'
          }
        },
        {
          method: 'DestroyPool',
          input: {
            name: POOL
          },
          error: {
            code: 5, // NOT_FOUND
            message: 'Pool not found'
          }
        },
        {
          method: 'ListPools',
          input: {},
          error: {
            code: 2, // UNKNOWN
            message: 'Internal error'
          }
        },
        {
          method: 'CreateReplica',
          input: {
            uuid: UUID,
            pool: POOL,
            size: { low: 1000 * (1024 * 1024), high: 0, unsigned: true },
            thin: true
          },
          error: {
            code: 6, // ALREADY_EXISTS
            message: 'Replica already exists'
          }
        },
        {
          method: 'DestroyReplica',
          input: {
            uuid: UUID
          },
          error: {
            code: 5, // NOT_FOUND
            message: 'Replica not found'
          }
        },
        {
          method: 'ShareReplica',
          input: {
            uuid: UUID,
            share: 1
          },
          error: {
            code: 5, // NOT_FOUND
            message: 'Replica not found'
          }
        },
        {
          method: 'ListReplicas',
          input: {},
          error: {
            code: 2, // UNKNOWN
            message: 'Internal error'
          }
        },
        {
          method: 'StatReplicas',
          input: {},
          error: {
            code: 2, // UNKNOWN
            message: 'Internal error'
          }
        }
      ]);
    });

    after(() => {
      if (mayastorMockServer) {
        mayastorMockServer.close(true);
      }
    });

    it('should not create a pool if it already exists', function (done) {
      const cmd = util.format('%s pool create %s %s', EGRESS_CMD, POOL, DISK);

      exec(cmd, (err, stdout, stderr) => {
        assert(err, 'Expected the command "' + cmd + '" to exit with error');
        assert.match(stderr, /Pool already exists/);
        assert.isEmpty(stdout);
        done();
      });
    });

    it('should not list the pools in case of internal error', function (done) {
      const cmd = util.format('%s -q pool list', EGRESS_CMD);

      exec(cmd, (err, stdout, stderr) => {
        assert(err, 'Expected the command "' + cmd + '" to exit with error');
        assert.match(stderr, /Internal error/);
        assert.isEmpty(stdout);
        done();
      });
    });

    it('should not destroy a pool if it does not exist', function (done) {
      const cmd = util.format('%s pool destroy %s', EGRESS_CMD, POOL);

      exec(cmd, (err, stdout, stderr) => {
        assert(err, 'Expected the command "' + cmd + '" to exit with error');
        assert.match(stderr, /Pool not found/);
        assert.isEmpty(stdout);
        done();
      });
    });

    it('should not create a replica if it already exists', function (done) {
      const cmd = util.format(
        '%s replica create %s %s --size=1000 --thin',
        EGRESS_CMD,
        POOL,
        UUID
      );

      exec(cmd, (err, stdout, stderr) => {
        assert(err, 'Expected the command "' + cmd + '" to exit with error');
        assert.match(stderr, /Replica already exists/);
        assert.isEmpty(stdout);
        done();
      });
    });

    it('should not share the replica if it does not exist', function (done) {
      const cmd = util.format('%s replica share %s nvmf', EGRESS_CMD, UUID);

      exec(cmd, (err, stdout, stderr) => {
        assert(err, 'Expected the command "' + cmd + '" to exit with error');
        assert.match(stderr, /Replica not found/);
        assert.isEmpty(stdout);
        done();
      });
    });

    it('should not list replicas in case of internal error', function (done) {
      const cmd = util.format('%s -q replica list', EGRESS_CMD);

      exec(cmd, (err, stdout, stderr) => {
        assert(err, 'Expected the command "' + cmd + '" to exit with error');
        assert.match(stderr, /Internal error/);
        assert.isEmpty(stdout);
        done();
      });
    });

    it('should not stat replicas in case of internal error', function (done) {
      const cmd = util.format('%s -q replica stats', EGRESS_CMD);

      exec(cmd, (err, stdout, stderr) => {
        assert(err, 'Expected the command "' + cmd + '" to exit with error');
        assert.match(stderr, /Internal error/);
        assert.isEmpty(stdout);
        done();
      });
    });

    it('should not destroy a replica if it does not exist', function (done) {
      const cmd = util.format('%s replica destroy %s', EGRESS_CMD, UUID);

      exec(cmd, (err, stdout, stderr) => {
        assert(err, 'Expected the command "' + cmd + '" to exit with error');
        assert.match(stderr, /Replica not found/);
        assert.isEmpty(stdout);
        done();
      });
    });
  });
});
