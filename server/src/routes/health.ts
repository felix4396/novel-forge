import { Router } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";

const router = Router();

router.get("/", (_req, res) => {
  const response: ApiResponse<{ status: string; timestamp: string }> = {
    success: true,
    data: {
      status: "ok",
      timestamp: new Date().toISOString(),
    },
    message: "服务运行正常。",
  };
  res.status(200).json(response);
});

export default router;
