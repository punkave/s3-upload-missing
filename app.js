var async = require('async');
var _ = require('lodash');
var AWS = require('aws-sdk');
var glob = require('glob');
var argv = require('boring')();
var path = require('path');
var fs = require('fs');
var contentTypes = require('./lib/contentTypes');
var s3 = new AWS.S3();

if (argv._.length !== 3) {
  console.error('Usage: s3-upload-missing from-local-path remote-bucket-name remote-path [--acl=private, --acl=public-read, etc.] [--delete]');
  console.error('');
  console.error('The --delete option removes a file from S3 if it does not also exist at the local path.');
  console.error('This should be used carefully.');
  console.error('');
  console.error('If --acl is not specified files are marked "private" (not web-accessible by the public).');
  process.exit(1);
}

var from = argv._[0];
var bucket = argv._[1];
var to = argv._[2];
var chmodIfNeeded = argv['chmod-if-needed'];

vlog('Finding local files...');
var local = _.map(glob.sync(from + '/**', { nodir: true }), function(name) {
  if (name.substr(0, from.length) === from) {
    name = name.substr(from.length);
  }
  if (name.substr(0, 1) === '/') {
    name = name.substr(1);
  }
  return name;
});

var remote = [];

var prefix = prefixFromTo(to);

async.series([
  list,
  compare,
  send,
  remove
], function(err) {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  vlog('DONE.');
  process.exit(0);
});

function list(callback) {
  vlog('Finding remote files...');
  return s3.listObjects({ Bucket: bucket, Prefix: prefix }).on('success', function handlePage(response) {
    remote = remote.concat(_.map(response.data.Contents, function(item) {
      var key = item.Key;
      return key.substr(prefix.length);
    }));
    vlog(remote.length);
    // do something with response.data
    if (response.hasNextPage()) {
      return response.nextPage().on('success', handlePage).send();
    }
    // Finished
    return callback(null);
  }).on('error', fail).send();

  function fail(err) {
    return callback(err);
  }
}

var missing;
var deleted;

function compare(callback) {
  var remoteMap = _.indexBy(remote, function(name) { return name; });
  var localMap = _.indexBy(local, function(name) { return name; });
  missing = _.filter(local, function(name) {
    return (!_.has(remoteMap, name));
  });
  deleted = _.filter(remote, function(name) {
    return (!_.has(localMap, name));
  })
  var found = _.filter(local, function(name) {
    return _.has(remoteMap, name);
  });
  vlog('Missing files:');
  vlog(missing.length);
  vlog('Found files:');
  vlog(found.length);
  if (argv['delete']) {
    vlog('Remote files that do not exist locally:');
    vlog(deleted.length);
  }
  return setImmediate(callback);
}

function send(callback) {
  var n = 0;
  // Send up to 2 files simultaneously, more than that probably isn't an efficiency gain because
  // it's mostly network time, but with two we mitigate the time wasted creating new HTTP connections a bit
  // and use the pipe a little more efficiently. I think.
  return async.eachLimit(missing, 2, function(item, callback) {
    n++;
    var ext = path.extname(item);
    if (ext.substr(0, 1) === '.') {
      ext = ext.substr(1);
    } else {
      ext = 'bin';
    }
    var contentType = contentTypes[ext] || 'application/octet-stream';
    var localPath = from;
    if (localPath.length && (!localPath.match(/\/$/))) {
      localPath += '/';
    }
    var local = localPath + item;
    var key = prefix;
    key += item;
    var chmodded = false;
    if (chmodIfNeeded) {
      var stats;
      try {
        stats = fs.statSync(local);
      } catch (e) {
        // Probably doesn't belong to us, this is not a fatal error
        vlog('cannot stat ' + local + ', probably not ours');
      }
      if (!(stats.mode & 0777)) {
        try {
          fs.chmodSync(local, 0700);
          chmodded = true;
          vlog('chmodded ' + local + ' to 0700 to copy it');
        } catch (e) {
          // Probably doesn't belong to us, this is not a fatal error
          vlog('cannot chmod ' + local + ', probably not ours to begin with');
          return callback(null);
        }
      }
    }
    var params = {
      Bucket: bucket, /* required */
      Key:  key,
      // if we had to chmod it from 000 it should be private in s3 too,
      // per uploadfs semantics
      ACL: chmodded ? 'private' : (argv.acl || 'private'),
      // CacheControl: 'STRING_VALUE',
      // ContentDisposition: 'STRING_VALUE',
      // ContentEncoding: 'STRING_VALUE',
      // ContentLanguage: 'STRING_VALUE',
      // ContentLength: 0,
      ContentType: contentType
    };
    vlog('Uploading ' + item + ' (' + n + ' of ' + missing.length + ')');
    var attempts = 0;
    function attempt() {
      if (params.Body) {
        // So we don't leak streams when retrying
        params.Body.destroy();
      }
      params.Body = fs.createReadStream(local);
      return s3.putObject(params, function(err, data) {
        if (err && (attempts < 10)) {
          attempts++;
          vlog('RETRYING: ' + attempts + ' of 10 (with exponential backoff)');
          setTimeout(attempt, 100 << attempts);
          return;
        }
        if (chmodded) {
          vlog('chmodded ' + local + ' back to 0000');
          fs.chmodSync(local, 0000);
        }
        return callback(err);
      });
    }
    return attempt();
  }, callback);
}

// max supported by s3
var deleteBatchSize = 1000;

function remove(callback) {
  if (!argv['delete']) {
    return setImmediate(callback);
  }
  if (!deleted.length) {
    return setImmediate(callback);
  }
  // Delete files using the batch API for performance
  var n = 0;
  var i = 0;
  return pass();

  function pass() {
    var params = {
      Bucket: bucket, /* required */
      Delete: {
        Objects: _.map(deleted.slice(i, i + deleteBatchSize), function(item) {
          return {
            Key: prefix + item
          };
        })
      }
    };
    i += deleteBatchSize;
    var count = params.Delete.Objects.length;
    n += count;
    vlog('Deleting ' + count + ' objects (' + n + ' of ' + deleted.length + ')');
    var attempts = 0;
    function attempt() {
      return s3.deleteObjects(params, function(err, data) {
        if (err && (attempts < 10)) {
          attempts++;
          vlog('RETRYING: ' + attempts + ' of 10 (with exponential backoff)');
          setTimeout(attempt, 100 << attempts);
          return;
        }
        if (err) {
          return callback(err);
        }
        if (i < deleted.length) {
          return pass();
        }
        return callback(null);
      });
    }
    return attempt();
  }
}

function vlog(s) {
  if (argv.verbose) {
    console.error(s);
  }
}

function prefixFromTo(to) {
  var prefix = to.replace(/^.\/?$/, '');
  if (prefix.length && (!prefix.match(/\/$/))) {
    prefix += '/';
  }
  return prefix;
}
