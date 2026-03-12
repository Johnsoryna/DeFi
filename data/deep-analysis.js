const fs = require("fs");
const trades = JSON.parse(fs.readFileSync("data/backtest-trades.json", "utf8"));
