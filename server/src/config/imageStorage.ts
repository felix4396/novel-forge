export type ImageStorageDriver = "local" | "s3";

export const imageStorageConfig = {
  driver: "local" as ImageStorageDriver,
  localRoot: "storage/generated-images",
  s3Endpoint: "",
  s3Region: "us-east-1",
  s3Bucket: "",
  s3AccessKeyId: "",
  s3SecretAccessKey: "",
  s3ForcePathStyle: true,
};

export function isS3ImageStorageEnabled(): boolean {
  return imageStorageConfig.driver === "s3";
}
