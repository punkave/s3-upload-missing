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
  console.error('Usage: s3-upload-missing from-local-path remote-bucket-name remote-path [--acl=private, --acl=public-read, etc.]');
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

vlog('Finding remote files...');
s3.listObjects({ Bucket: bucket, Prefix: prefix }).on('success', function handlePage(response) {
  remote = remote.concat(_.map(response.data.Contents, function(item) {
    var key = item.Key;
    return key.substr(prefix.length);
  }));
  vlog(remote.length);
  // do something with response.data
  if (response.hasNextPage()) {
    return response.nextPage().on('success', handlePage).send();
  }
  return compare();
}).on('error', fail).send();

function fail(error) {
  console.error(error);
  process.exit(1);
}

var missing;

function compare() {
  var remoteMap = _.indexBy(remote, function(name) { return name; });
  missing = _.filter(local, function(name) {
    return (!_.has(remoteMap, name));
  });
  var found = _.filter(local, function(name) {
    return _.has(remoteMap, name);
  });
  vlog('Missing files:');
  vlog(missing.length);
  vlog('Found files:');
  vlog(found.length);
  return send();
}

function send() {
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
      try {
        fs.accessSync(local, fs.R_OK);
      } catch (e) {
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
      Body: fs.createReadStream(local),
      // CacheControl: 'STRING_VALUE',
      // ContentDisposition: 'STRING_VALUE',
      // ContentEncoding: 'STRING_VALUE',
      // ContentLanguage: 'STRING_VALUE',
      // ContentLength: 0,
      ContentType: contentType
    };
    vlog('Uploading ' + item + ' (' + n + ' of ' + missing.length + ')');
    return s3.putObject(params, function(err, data) {
      if (chmodded) {
        vlog('chmodded ' + local + ' back to 0000');
        fs.chmodSync(local, 0000);
      }
      if (err) {
        return callback(err);
      }
      return callback(null);
    });
  }, function(err) {
    if (err) {
      vlog(err);
      process.exit(1);
    }
    vlog('DONE.');
    process.exit(0);
  });
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
