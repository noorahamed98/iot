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
  const { thingNames } = req.body;
  if (!Array.isArray(thingNames) || thingNames.length === 0) {
    return res.send("❌ One or more thing names are required.");
  }

  const created = [];
  const alreadyExists = [];
  const history = readHistory();

  for (const name of thingNames) {
    const folderPath = path.join(__dirname, "certs", name);
    const zipPath = path.join(__dirname, "certs", `${name}.zip`);

    if (fs.existsSync(zipPath)) {
      if (!history.some(entry => entry.name === name)) {
        history.push({ name, createdAt: new Date().toISOString() });
      }
      alreadyExists.push(name);
      continue;
    }

    try {
      await new Promise((resolve, reject) => {
        exec(`bash ./create-iot-thing.sh ${name}`, (error, stdout, stderr) => {
          if (error) {
            console.error(`❌ Error creating ${name}:`, stderr);
            return reject(stderr);
          }

          if (!history.some(entry => entry.name === name)) {
            history.push({ name, createdAt: new Date().toISOString() });
          }

          const output = fs.createWriteStream(zipPath);
          const archive = archiver("zip", { zlib: { level: 9 } });

          archive.on("error", err => reject(err));
          archive.pipe(output);
          archive.directory(folderPath, name);
          archive.finalize();

          output.on("close", () => {
            created.push(name);
            resolve();
          });
        });
      });
    } catch (err) {
      console.error(`Error with ${name}:`, err);
    }
  }

  writeHistory(history);

  res.send(`
    <pre>✅ Success!
Created: ${created.length} thing(s)
${created.join("\n")}

⚠️ Already existed: ${alreadyExists.length}
${alreadyExists.join("\n")}
</pre>
${created.map(n => `<a href="/certs/${n}.zip" download>⬇️ ${n}.zip</a>`).join("<br>")}
  `);
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

// ✅ Start server
app.listen(PORT, () => {
  console.log(`🚀 IOTIQ App running at http://localhost:${PORT}`);
});
