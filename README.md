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
```

This tool was written due to persistent problems with `s3cmd` attempting to resend the same files and not making further progress. It was also a good opportunity to test out the official AWS SDK instead of using knox.

(Verdict: good stuff.)

