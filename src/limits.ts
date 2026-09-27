/**
 * 自定义上传音频的产品硬上限：200 MiB（= 209,715,200 字节）。
 *
 * 这是 authoritative product rule，由 Cloudflare 在每一个入口执行（初始化 / 分片 / complete /
 * 最终对象大小 / 创建任务 / 转录服务拉取）；前端与转录服务只是各自的防御性副本。
 */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** 分片大小：R2 multipart 要求除最后一片外每片等大且 ≥ 5 MiB；前端按此切片。 */
export const MAX_PART_BYTES = 10 * 1024 * 1024;

/** 合法上传最多需要的分片数：ceil(200 MiB / 10 MiB) = 20。多于此数的分片一律拒绝。 */
export const MAX_PARTS = Math.ceil(MAX_UPLOAD_BYTES / MAX_PART_BYTES);

/** raw transcript 的入库上限（字符数）：真实 3 小时播客的转录远低于此。 */
export const MAX_RAW_BYTES = 8 * 1024 * 1024;
