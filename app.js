var async = require('async');
var _ = require('lodash');
var AWS = require('aws-sdk');
var glob = require('glob');
var argv = require('boring')();
var path = require('path');
var contentTypes = require('./lib/contentTypes');
var s3 = new AWS.S3();
var fs;

if (argv._.length !== 3) {
  console.error('Usage: s3-upload-missing from-local-path remote-bucket-name remote-path');
  process.exit(1);
}

var from = argv._[0];
var bucket = argv._[1];
var to = argv._[2];

var local = _.map(glob.sync(from + '/**'), function(name) {
  if (name.substr(0, from.length) === from) {
    name = name.substr(from.length);
  }
  if (name.substr(0, 1) === '/') {
    name = name.substr(1);
  }
  return name;
});

console.log(local);
var remote = [];

s3.listObjects({ Bucket: bucket }).on('success', function handlePage(response) {
  remote = remote.concat(_.map(response.data.Contents, 'Key'));
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
  var localMap = _.indexBy(local, function(name) { return name; });
  console.log(remote);
  missing = _.filter(remote, function(name) {
    return (!_.has(localMap, name));
  });
  var found = _.filter(remote, function(name) {
    return _.has(localMap, name);
  });
  console.log('Missing files:');
  console.log(missing.length);
  console.log('Found files:');
  console.log(found.length);
  return send();
}

function send() {
  return async.eachSeries(missing, function(item, callback) {
    var ext = path.extname(item);
    if (ext.substr(0, 1) === '.') {
      ext = ext.substr(1);
    } else {
      ext = 'bin';
    }
    var contentType = contentTypes[ext] || 'application/octet-stream';
    var params = {
      Bucket: bucket, /* required */
      Key: item,
      ACL: 'public-read',
      Body: fs.open(from + item, 'r'),
      // CacheControl: 'STRING_VALUE',
      // ContentDisposition: 'STRING_VALUE',
      // ContentEncoding: 'STRING_VALUE',
      // ContentLanguage: 'STRING_VALUE',
      // ContentLength: 0,
      ContentType: contentType
    };
    console.log('Uploading ' + item);
    return s3.putObject(params, function(err, data) {
      if (err) {
        return callback(err);
      }
      return callback(null);
    });
  }, function(err) {
    if (err) {
      console.error(err);
      process.exit(1);
      console.log('DONE.');
      process.exit(0);
    }
  });
}
