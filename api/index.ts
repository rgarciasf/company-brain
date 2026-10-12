// Vercel Function entry point: every request is rewritten here (see vercel.json) and served by the
// same handler as the local server. State lives in ClickHouse, so any instance can serve any request.
import { handle } from "../src/app.ts";

export default handle;
