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

// ✅ Create Thing + ZIP
app.post("/create", (req, res) => {
  const thingName = req.body.thingName;
  if (!thingName) return res.send("❌ Thing name is required.");

  const folderPath = path.join(__dirname, "certs", thingName);
  const zipPath = path.join(__dirname, "certs", `${thingName}.zip`);
  const history = readHistory();

  if (fs.existsSync(zipPath)) {
    const alreadyInHistory = history.some(entry => entry.name === thingName);
    if (!alreadyInHistory) {
      history.push({ name: thingName, createdAt: new Date().toISOString() });
      writeHistory(history);
    }
    return res.send(`
<pre>✅ Success:
⚠️ Thing '${thingName}' already exists and ZIP file is downloaded.
ℹ️ To recreate, delete the Thing from AWS IoT and remove: ./certs/${thingName}.zip
</pre>
<a href="/certs/${thingName}.zip" download>⬇️ Download Certificates</a>
    `);
  }

  exec(`bash ./create-iot-thing.sh ${thingName}`, (error, stdout, stderr) => {
    if (error) {
      return res.send(`<pre>❌ Error:\n${stderr}</pre>`);
    }

    if (!history.some(entry => entry.name === thingName)) {
      history.push({ name: thingName, createdAt: new Date().toISOString() });
      writeHistory(history);
    }

    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
      res.send(`
<pre>✅ Success:\n${stdout}</pre>
<a href="/certs/${thingName}.zip" download>⬇️ Download Certificates</a>
      `);
    });

    archive.on("error", err => {
      console.error("Archive error:", err);
      res.send(`<pre>❌ Error creating zip:\n${err.message}</pre>`);
    });

    archive.pipe(output);
    archive.directory(folderPath, thingName);
    archive.finalize();
  });
});

// ✅ Device History
app.get("/history", (req, res) => {
  let history = readHistory();
  const unique = Array.from(new Map(history.map(item => [item.name, item])).values());

  const { from, to } = req.query;
  if (from && to) {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    const filtered = unique.filter(t => {
      const createdAt = new Date(t.createdAt);
      return createdAt >= fromDate && createdAt <= toDate;
    });
    return res.json(filtered);
  }

  res.json(unique);
});

// ✅ Monthly Devices by Month Picker (YYYY-MM)
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

// ✅ NEW: Monthly Device List HTML Page
app.get("/monthly-device-list", (req, res) => {
  const { month, year } = req.query;
  if (!month || !year) {
    return res.status(400).send("<h3>❌ Month and Year required in query string.</h3>");
  }

  const history = readHistory();
  const filtered = history.filter(entry => {
    const created = new Date(entry.createdAt);
    return created.getMonth() + 1 === Number(month) && created.getFullYear() === Number(year);
  });

  const html = `
    <html>
    <head>
      <title>Monthly Devices (${month}/${year})</title>
      <style>
        body { font-family: Arial; padding: 2rem; background: #f0f8ff; }
        h2 { margin-bottom: 1rem; }
        ul { list-style: none; padding: 0; }
        li { background: #fff; margin-bottom: 10px; padding: 10px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 0 5px rgba(0,0,0,0.1); }
        a { background: #007bff; color: white; padding: 6px 10px; border-radius: 4px; text-decoration: none; }
        a:hover { background: #0056b3; }
      </style>
    </head>
    <body>
      <h2>📋 Devices Created in ${month}/${year}</h2>
      <ul>
        ${filtered.map(entry => `
          <li>
            <span>${entry.name}</span>
            <a href="/certs/${entry.name}.zip" download>⬇️ Download</a>
          </li>
        `).join("")}
      </ul>
    </body>
    </html>
  `;

  res.send(html);
});

// ✅ Download JSON file (still works if needed)
app.post("/download-history", (req, res) => {
  const { startDate, endDate } = req.body;
  if (!startDate || !endDate) {
    return res.status(400).json({ error: "Both startDate and endDate are required." });
  }

  const history = readHistory();
  const filtered = history.filter(entry => {
    const createdAt = new Date(entry.createdAt);
    return createdAt >= new Date(startDate) && createdAt <= new Date(endDate);
  });

  res.json(filtered);
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

// ✅ Count Devices This Month
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

// ✅ Full-text Search via meta.json
app.get("/search", (req, res) => {
  const query = req.query.q?.toLowerCase() || "";
  const certsPath = path.join(__dirname, "certs");
  const results = [];

  if (!fs.existsSync(certsPath)) return res.json([]);

  const folders = fs.readdirSync(certsPath).filter(f => fs.statSync(path.join(certsPath, f)).isDirectory());

  folders.forEach(folder => {
    const metaPath = path.join(certsPath, folder, "meta.json");
    const certPath = path.join(certsPath, folder, "certificate.pem.crt");

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
          results.push({
            ...meta,
            thingAttached: fs.existsSync(certPath),
            firmwareUrl: fs.existsSync(path.join(certsPath, folder, "firmware.bin"))
              ? `/certs/${folder}/firmware.bin` : null,
            configUrl: fs.existsSync(path.join(certsPath, folder, "config.json"))
              ? `/certs/${folder}/config.json` : null
          });
        }
      } catch (err) {
        console.warn(`⚠️ Error parsing meta.json for ${folder}`);
      }
    }
  });

  res.json(results);
});

app.listen(PORT, () => {
  console.log(`🚀 IOTIQ App running at http://localhost:${PORT}`);
});


