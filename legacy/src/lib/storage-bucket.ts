import { readFile } from "node:fs/promises";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

type BucketConfig = {
  bucketName: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

declare global {
  var bucketClient: S3Client | undefined;
  var bucketConfig: BucketConfig | undefined;
}

function readRequiredEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function getBucketConfig(): BucketConfig {
  if (!globalThis.bucketConfig) {
    globalThis.bucketConfig = {
      bucketName: readRequiredEnv("AWS_S3_BUCKET_NAME"),
      endpoint: readRequiredEnv("AWS_ENDPOINT_URL"),
      region:
        process.env.AWS_REGION ??
        process.env.AWS_DEFAULT_REGION ??
        "auto",
      accessKeyId: readRequiredEnv("AWS_ACCESS_KEY_ID"),
      secretAccessKey: readRequiredEnv("AWS_SECRET_ACCESS_KEY"),
      forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === "true",
    };
  }

  return globalThis.bucketConfig;
}

function getBucketClient() {
  if (!globalThis.bucketClient) {
    const config = getBucketConfig();

    globalThis.bucketClient = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  return globalThis.bucketClient;
}

export function hasBucketConfig() {
  return Boolean(
    process.env.AWS_S3_BUCKET_NAME &&
      process.env.AWS_ENDPOINT_URL &&
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY,
  );
}

export function isExternalAssetUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

export async function createPresignedReadUrl(objectKey: string) {
  const { bucketName } = getBucketConfig();

  return getSignedUrl(
    getBucketClient(),
    new GetObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
    }),
    {
      expiresIn: DOWNLOAD_URL_TTL_SECONDS,
    },
  );
}

export async function uploadFirmwareObject(params: {
  contentType?: string;
  filePath: string;
  objectKey: string;
}) {
  const { bucketName } = getBucketConfig();
  const body = await readFile(params.filePath);

  await getBucketClient().send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: params.objectKey,
      Body: body,
      ContentType: params.contentType ?? "application/octet-stream",
    }),
  );

  return {
    bucketName,
    objectKey: params.objectKey,
    sizeBytes: body.byteLength,
  };
}
