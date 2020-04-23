'use strict';

var spawn = require('child_process').spawn;
var path = require('path');
var read = require('read');
var inpathSync = require('inpath').sync;
var pidof = require('pidof');

const sudoBin = inpathSync('sudo', process.env.PATH.split(':'));

var cachedPassword;
var lastAnswer;

function sudo (command, options, nameInPs) {
  var prompt = '#node-sudo-passwd#';
  var prompts = 0;
  nameInPs = nameInPs || path.basename(command[0]);

  var args = ['-S', '-E', '-p', prompt];
  args.push.apply(args, command);
  options = options || {};
  var spawnOptions = options.spawnOptions || {};
  spawnOptions.stdio = 'pipe';

  var child = spawn(sudoBin, args, spawnOptions);

  // Wait for the sudo:d binary to start up
  function waitForStartup (err, pid) {
    if (err) {
      throw new Error("Couldn't start " + nameInPs);
    }

    if (pid || child.exitCode !== null) {
      child.emit('started');
    } else {
      setTimeout(function () {
        pidof(nameInPs, waitForStartup);
      }, 100);
    }
  }
  // XXX this is not reliable in case of multiple instances of the same command
  // (we cannot match by name in that case).
  pidof(nameInPs, waitForStartup);

  // FIXME: Remove this handler when the child has successfully started
  child.stderr.on('data', function (data) {
    var lines = data
      .toString()
      .trim()
      .split('\n');
    lines.forEach(function (line) {
      if (line === prompt) {
        if (++prompts > 1) {
          // The previous entry must have been incorrect, since sudo asks again.
          cachedPassword = null;
        }

        if (options.cachePassword && cachedPassword) {
          child.stdin.write(cachedPassword + '\n');
        } else {
          read(
            {
              prompt: options.prompt || 'sudo requires your password: ',
              silent: true
            },
            function (error, answer) {
              child.stdin.write(answer + '\n');
              if (options.cachePassword) {
                cachedPassword = answer;
              }
            }
          );
        }
      }
    });
  });

  return child;
}

module.exports = sudo;
