import { env } from "./config/env";
import { app } from "./app";

app.listen(env.API_PORT, () => {
  console.log(`MonMate API listening on http://localhost:${env.API_PORT}`);
});
