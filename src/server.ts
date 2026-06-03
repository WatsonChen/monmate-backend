import { env } from "./config/env.js";
import { app } from "./app.js";

app.listen(env.API_PORT, () => {
  console.log(`MonMate API listening on http://localhost:${env.API_PORT}`);
});
