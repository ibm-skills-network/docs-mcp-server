#!/usr/bin/env node
import { startHttp } from "./http.js";
import { logger } from "./utils/logger";

startHttp().catch((error) => {
  logger.error(`❌ Fatal Error: ${error}`);
  process.exit(1);
});
