```
# Shovel this folder's contents, recursively, up to mybucket.
# If a file is already there, it is not sent again
s3-upload-missing . mybucketname .

# Do it with verbose output
s3-upload-missing --verbose . mybucketname .

# Specify a prefix in the destination bucket.
# A slash at the end is implied if not provided
s3-upload-missing --verbose . mybucketname uploads

# Allow the public to read the files (web-accessible)
s3-upload-missing --verbose . mybucketname uploads --acl=public-read

# If a file is unreadable, chmod it momentarily so we
# can read it, then send it to S3 with "private" permissions.
# Then chmod it back to 000
s3-upload-missing --verbose . mybucketname uploads --acl=public-read --chmod-if-needed

# Also remove any remote files that do not exist locally.
# Use with care
s3-upload-missing . mybucketname . --delete
```

"Why not use s3cmd?" `s3cmd` works fine, but we have a peculiar need to successfully upload files with permissions `000` and give them the `private` acl on s3 (the `--chmod-if-needed` option). This is very useful when transitioning from local files to s3 with [uploadfs](https://www.npmjs.com/package/uploadfs).

