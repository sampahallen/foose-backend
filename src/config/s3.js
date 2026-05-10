const { S3Client } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");

const hasS3Config = () =>
  Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      process.env.AWS_REGION &&
      process.env.S3_BUCKET_NAME,
  );

const s3Client = hasS3Config()
  ? new S3Client({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    })
  : null;

const publicUrlForKey = (key) => {
  if (process.env.CLOUDFRONT_URL) {
    return `${process.env.CLOUDFRONT_URL.replace(/\/$/, "")}/${key}`;
  }

  return `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
};

const uploadBuffer = async ({ buffer, mimetype, key }) => {
  if (!s3Client) {
    return `local-s3-disabled://${key}`;
  }

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    },
  });

  await upload.done();

  return publicUrlForKey(key);
};

module.exports = {
  uploadBuffer,
};
