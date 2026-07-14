#!/usr/bin/env node

import { runDashboardStrategySelfTest } from "../src/dashboard-strategy.js";

console.log(JSON.stringify({
  level: "dashboard-strategy-self-test",
  ...runDashboardStrategySelfTest(),
  status: "ok"
}));
