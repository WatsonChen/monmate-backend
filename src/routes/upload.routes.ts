import { put } from "@vercel/blob";
import { Router } from "express";
import multer from "multer";
import { asyncHandler } from "../lib/async-handler.js";
import { AppError, ok } from "../lib/http.js";
import { requireAuth } from "../middlewares/auth.js";

export const uploadRouter = Router();

const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE }
});

uploadRouter.use(requireAuth);

uploadRouter.post(
  "/image",
  upload.single("file") as never,
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError(400, "FILE_REQUIRED", "請選擇圖片檔案");
    if (!ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
      throw new AppError(400, "INVALID_FILE_TYPE", "僅支援 PNG、JPG、WebP 格式");
    }

    const ext = req.file.mimetype.split("/")[1];
    const pathname = `event-logos/${req.user!.id}-${Date.now()}.${ext}`;

    const blob = await put(pathname, req.file.buffer, {
      access: "public",
      contentType: req.file.mimetype
    });

    return ok(res, { url: blob.url });
  })
);
