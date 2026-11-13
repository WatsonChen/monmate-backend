import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { corsOrigins } from "./config/env.js";
import { errorHandler, notFound } from "./middlewares/error.js";
import { routes } from "./routes/index.js";

export const app = express();

app.use(helmet());
app.use(
  cors({
    origin: corsOrigins,
    credentials: true
  })
);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
// 網址的查詢字串含有票券／問卷的 QR token，日誌只記路徑，不記查詢字串
morgan.token("path-only", (req) => (req as express.Request).originalUrl.split("?")[0]);
app.use(morgan(":method :path-only :status :response-time ms - :res[content-length]"));

app.get("/health", (_req, res) => {
  res.json({ success: true, data: { status: "ok" } });
});

app.use(routes);
app.use(notFound);
app.use(errorHandler);

export default app;
