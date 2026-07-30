import { Router } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { referenceLibraryService } from "../services/referenceLibrary/ReferenceLibraryService";

const router = Router();
const idParamsSchema = z.object({ id: z.string().trim().min(1) });
const searchSchema = z.object({
  authors: z.array(z.string().trim().min(1)).min(1).max(20),
});
const downloadSchema = z.object({
  searchJobId: z.string().trim().min(1),
  candidateIds: z.array(z.string().trim().min(1)).min(1).max(100),
});
const listBooksSchema = z.object({ keyword: z.string().trim().optional() });

router.use(authMiddleware);

router.post("/search-jobs", validate({ body: searchSchema }), async (req, res, next) => {
  try {
    const data = await referenceLibraryService.createSearchJob(req.body.authors);
    res.status(202).json({ success: true, data, message: "参考书搜索任务已创建。" } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/search-jobs/:id", validate({ params: idParamsSchema }), async (req, res, next) => {
  try {
    const { id } = idParamsSchema.parse(req.params);
    const data = await referenceLibraryService.getSearchJob(id);
    if (!data) return void res.status(404).json({ success: false, error: "搜索任务不存在。" } satisfies ApiResponse<null>);
    res.json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/download-jobs", validate({ body: downloadSchema }), async (req, res, next) => {
  try {
    const data = await referenceLibraryService.createDownloadJobs(req.body.searchJobId, req.body.candidateIds);
    res.status(202).json({ success: true, data, message: "下载任务已加入队列。" } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/download-jobs", async (_req, res, next) => {
  try {
    const data = await referenceLibraryService.listDownloadJobs();
    res.json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/download-jobs/:id", validate({ params: idParamsSchema }), async (req, res, next) => {
  try {
    const { id } = idParamsSchema.parse(req.params);
    const data = await referenceLibraryService.getDownloadJob(id);
    if (!data) return void res.status(404).json({ success: false, error: "下载任务不存在。" } satisfies ApiResponse<null>);
    res.json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/books", validate({ query: listBooksSchema }), async (req, res, next) => {
  try {
    const data = await referenceLibraryService.listBooks(req.query.keyword as string | undefined);
    res.json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/books/:id", validate({ params: idParamsSchema }), async (req, res, next) => {
  try {
    const { id } = idParamsSchema.parse(req.params);
    const data = await referenceLibraryService.getBook(id);
    if (!data) return void res.status(404).json({ success: false, error: "书籍不存在。" } satisfies ApiResponse<null>);
    res.json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.get("/books/:id/file", validate({ params: idParamsSchema }), async (req, res, next) => {
  try {
    const { id } = idParamsSchema.parse(req.params);
    const file = await referenceLibraryService.resolveBookFile(id);
    if (!file) return void res.status(404).json({ success: false, error: "EPUB 文件不存在。" } satisfies ApiResponse<null>);
    res.download(file.path, file.fileName);
  } catch (error) {
    next(error);
  }
});

router.delete("/books/:id/file", validate({ params: idParamsSchema }), async (req, res, next) => {
  try {
    const { id } = idParamsSchema.parse(req.params);
    await referenceLibraryService.removeBookFile(id);
    res.json({ success: true, data: null, message: "EPUB 已删除，知识文档已保留。" } satisfies ApiResponse<null>);
  } catch (error) {
    next(error);
  }
});

router.post("/books/:id/redownload", validate({ params: idParamsSchema }), async (req, res, next) => {
  try {
    const { id } = idParamsSchema.parse(req.params);
    const data = await referenceLibraryService.redownload(id);
    res.status(202).json({ success: true, data, message: "重新下载任务已创建。" } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

router.post("/books/:id/retry-import", validate({ params: idParamsSchema }), async (req, res, next) => {
  try {
    const { id } = idParamsSchema.parse(req.params);
    const data = await referenceLibraryService.retryImport(id);
    res.json({ success: true, data, message: "EPUB 已重新导入知识库。" } satisfies ApiResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

export default router;
