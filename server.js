const express = require("express");
const bodyParser = require("body-parser");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");

const app = express();
const PORT = 80;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static("public"));
app.use(express.json());
app.use("/certs", express.static(path.join(__dirname, "certs")));

const HISTORY_FILE = path.join(__dirname, "history.json");

function readHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  return JSON.parse(fs.readFileSync(HISTORY_FILE));
}

function writeHistory(data) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
}

// ✅ Create Multiple Things + ZIPs
app.post("/create", async (req, res) => {
  const { type, baseModel, tankModel, count, user } = req.body;
  if (!type || !count || (type === "Base" && !baseModel) || (type === "Tank" && !tankModel)) {
    return res.status(400).send("Invalid input");
  }

  const prefix = type === "Tank" ? tankPrefixes[tankModel] : basePrefixes[baseModel];
  const now = new Date();
  const dateCode = `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getFullYear()).slice(-2)}`;

  try {
    const things = await listThingsByPrefix(`${prefix}${dateCode}A`);
    const maxId = things.reduce((max, thing) => {
      const match = thing.match(/A(\d{3})$/);
      const num = match ? parseInt(match[1]) : 0;
      return Math.max(max, num);
    }, 0);

    const pad = (n) => n.toString().padStart(3, "0");
    const newThings = [];
    for (let i = 1; i <= count; i++) {
      const id = maxId + i;
      const thingName = `${prefix}${dateCode}A${pad(id)}`;
      newThings.push(thingName);
    }

    // Step 1: Create all things concurrently
    await Promise.all(
      newThings.map(async (name) => {
        const model = baseModel || tankModel || "";
        await execPromise(`bash ./create-iot-thing.sh ${name} ${type} ${model}`);
      })
    );

    // Step 2: Generate headers + update history asynchronously
    setTimeout(() => {
      newThings.forEach(name => {
        const certDir = path.join(__dirname, "certs", name);
        try {
          generateHeaderFile(name, certDir);
        } catch (e) {
          console.error("Header generation failed for", name, e);
        }
      });

      const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile)) : [];
      const newHistory = newThings.map(name => ({
        name,
        createdAt: new Date().toISOString(),
        user: user || "Unknown"
      }));
      fs.writeFileSync(historyFile, JSON.stringify([...history, ...newHistory], null, 2));
    }, 0); // Non-blocking

    const createdList = newThings.map(n => `<li>${n}</li>`).join("");
    res.send(`✅ Created ${count} thing(s):<ul>${createdList}</ul>`);

  } catch (err) {
    console.error("Create error:", err);
    res.status(500).send("Error creating one or more things.");
  }
});


// ✅ Device History Page
app.get("/history", (req, res) => {
  const history = readHistory();
  const unique = Array.from(new Map(history.map(item => [item.name, item])).values());

  const html = `
    <html>
    <head>
      <title>Device History</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; background: #f0f2f5; }
        h2 { color: #333; }
        ul { list-style: none; padding: 0; }
        li { background: white; margin-bottom: 10px; padding: 10px; border-radius: 8px; box-shadow: 0 0 5px rgba(0,0,0,0.1); }
      </style>
    </head>
    <body>
      <h2>📋 All Created Things</h2>
      <ul>
        ${unique.map(entry => `
          <li>
            🆔 <strong>${entry.name}</strong><br/>
            📅 Created at: ${new Date(entry.createdAt).toLocaleString()}<br/>
            📦 <a href="/certs/${entry.name}.zip" download>Download ZIP</a>
          </li>
        `).join("")}
      </ul>
    </body>
    </html>
  `;

  res.send(html);
});

// ✅ JSON API for Device History (used by frontend JS)
app.get("/api/history", (req, res) => {
  const history = readHistory();
  res.json(history);
});

// ✅ Monthly Devices
app.get("/monthly-devices", (req, res) => {
  const { month, year } = req.query;
  if (!month || !year) return res.status(400).json({ error: "Month and Year required" });

  const history = readHistory();
  const filtered = history.filter(entry => {
    const created = new Date(entry.createdAt);
    return created.getMonth() + 1 === Number(month) && created.getFullYear() === Number(year);
  });

  res.json(filtered);
});

// ✅ Monthly Stats Count
app.get("/monthly-thing-count", (req, res) => {
  const history = readHistory();
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  const monthlyCount = history.filter(entry => {
    const createdAt = new Date(entry.createdAt);
    return createdAt.getMonth() === currentMonth && createdAt.getFullYear() === currentYear;
  }).length;

  res.json({ month: now.toLocaleString("default", { month: "long" }), year: currentYear, count: monthlyCount });
});

// ✅ Delete Device
app.post("/delete", (req, res) => {
  const { thingName } = req.body;
  if (!thingName) return res.send("❌ Thing name is required.");

  exec(`bash ./delete-iot-thing.sh ${thingName}`, (error, stdout, stderr) => {
    if (error) {
      return res.send(`<pre>❌ Error:\n${stderr}</pre>`);
    }

    const history = readHistory().filter(t => t.name !== thingName);
    writeHistory(history);

    const certDir = path.join(__dirname, "certs", thingName);
    const zipFile = path.join(__dirname, "certs", `${thingName}.zip`);
    fs.rmSync(certDir, { recursive: true, force: true });
    fs.rmSync(zipFile, { force: true });

    res.send(`<pre>🗑️ Deleted Thing ${thingName} from AWS & Local</pre>`);
  });
});

// ✅ Full-text Search
app.get("/search", (req, res) => {
  const query = req.query.q?.toLowerCase() || "";
  const certsPath = path.join(__dirname, "certs");
  const results = [];

  if (!fs.existsSync(certsPath)) return res.json([]);

  const folders = fs.readdirSync(certsPath).filter(f => fs.statSync(path.join(certsPath, f)).isDirectory());

  folders.forEach(folder => {
    const metaPath = path.join(certsPath, folder, "meta.json");

    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        const match = [
          meta.thingName,
          meta.userName,
          meta.deviceId,
          meta.company,
          meta.deviceStatus,
        ].some(field => field?.toLowerCase().includes(query));

        if (match) {
          results.push(meta);
        }
      } catch (err) {
        console.warn(`⚠️ Error parsing meta.json for ${folder}`);
      }
    }
  });

  res.json(results);
});
app.post("/delete-all", async (req, res) => {
  try {
    const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile)) : [];

    for (const entry of history) {
      const thingName = entry.name;
      try {
        await execPromise(`bash ./delete-iot-thing.sh ${thingName}`);
      } catch (err) {
        console.warn(`⚠️ Error deleting ${thingName}:`, err.message);
      }

      const certDir = path.join(__dirname, "certs", thingName);
      const headerFile = path.join(__dirname, "certs", `${thingName}.h`);
      if (fs.existsSync(certDir)) {
        fs.rmSync(certDir, { recursive: true, force: true });
      }
      if (fs.existsSync(headerFile)) {
        fs.rmSync(headerFile, { force: true });
      }
    }

    // Clear the history file
    fs.writeFileSync(historyFile, JSON.stringify([], null, 2));
    res.send("✅ All devices deleted successfully.");
  } catch (err) {
    console.error("❌ Error in /delete-all:", err);
    res.status(500).send("❌ Failed to delete all devices.");
  }
});


// ✅ Start server
app.listen(PORT, () => {
  console.log(`🚀 IOTIQ App running at http://localhost:${PORT}`);
});
