const {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

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

const uploadPrivateBuffer = async ({ buffer, mimetype, key }) => {
  if (!s3Client) {
    const error = new Error(
      "Private attachment storage is unavailable; configure the S3 environment before uploading",
    );
    error.statusCode = 503;
    throw error;
  }

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: envValue("S3_BUCKET_NAME"),
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    },
  });

  await upload.done();
  return { key, storage: "s3" };
};

const deletePrivateObject = async (key) => {
  if (!key || !s3Client) return;

  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: envValue("S3_BUCKET_NAME"),
      Key: key,
    }),
  );
};

const createPrivateDownloadUrl = async (key, expiresIn = 300) => {
  if (!key) return null;
  if (!s3Client) return null;

  return getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: envValue("S3_BUCKET_NAME"),
      Key: key,
    }),
    { expiresIn: Math.min(Math.max(Number(expiresIn) || 300, 1), 300) },
  );
};

module.exports = {
  createPrivateDownloadUrl,
  deletePrivateObject,
  uploadBuffer,
  uploadPrivateBuffer,
};
