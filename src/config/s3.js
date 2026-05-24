const { S3Client } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");

const envValue = (name) => (process.env[name] || "").trim();

const hasS3Config = () =>
  Boolean(
    envValue("AWS_ACCESS_KEY_ID") &&
      envValue("AWS_SECRET_ACCESS_KEY") &&
      envValue("AWS_REGION") &&
      envValue("S3_BUCKET_NAME"),
  );

const s3Client = hasS3Config()
  ? new S3Client({
      region: envValue("AWS_REGION"),
      credentials: {
        accessKeyId: envValue("AWS_ACCESS_KEY_ID"),
        secretAccessKey: envValue("AWS_SECRET_ACCESS_KEY"),
      },
    })
  : null;

const publicUrlForKey = (key) => {
  const cloudfrontUrl = envValue("CLOUDFRONT_URL");
  if (cloudfrontUrl) {
    return `${cloudfrontUrl.replace(/\/$/, "")}/${key}`;
  }

  return `https://${envValue("S3_BUCKET_NAME")}.s3.${envValue("AWS_REGION")}.amazonaws.com/${key}`;
};

const uploadBuffer = async ({ buffer, mimetype, key }) => {
  if (!s3Client) {
    return `local-s3-disabled://${key}`;
  }

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: envValue("S3_BUCKET_NAME"),
      Key: key,
      Body: buffer,
      ContentType: mimetype,
      ACL: "public-read",
    },
  });

  await upload.done();

  return publicUrlForKey(key);
};

module.exports = {
  uploadBuffer,
};
