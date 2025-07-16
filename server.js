const express = require("express");
const bodyParser = require("body-parser");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const util = require("util");
const AWS = require("aws-sdk");
const execPromise = util.promisify(exec);

const app = express();
const PORT = 80;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static("public"));
app.use(express.json());
app.use("/certs", express.static(path.join(__dirname, "certs")));

const historyFile = path.join(__dirname, "history.json");
const usersFile = path.join(__dirname, "users.json");
const modelsFile = path.join(__dirname, "models.json");

// Default model values if file doesn't exist
if (!fs.existsSync(modelsFile)) {
  fs.writeFileSync(modelsFile, JSON.stringify({
    Base: {
      IOTIQBM_1: "IoTIQbm1",
      IOTIQBM_2: "IoTIQbm2",
      IOTIQBM_3: "IoTIQbm3",
      ACSBM: "IoTIQbmA"
    },
    Tank: {
      FUNNELBM_1: "funnelbm1",
      FUNNELBM_2: "funnelbm2",
      FUNNELBM_3: "funnelbm3"
    }
  }, null, 2));
}

AWS.config.update({ region: "ap-south-1" });
const iot = new AWS.Iot();

function getModels() {
  return JSON.parse(fs.readFileSync(modelsFile));
}

function generateHeaderFile(thingName, certDir) {
  const certPath = path.join(certDir, "certificate.pem.crt");
  const keyPath = path.join(certDir, "private.pem.key");
  const caPath = path.join(certDir, "AmazonRootCA1.pem");
  const pubPath = path.join(certDir, "public.pem.key");

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath) || !fs.existsSync(caPath) || !fs.existsSync(pubPath)) {
    throw new Error(`Missing certificate files for ${thingName}`);
  }

  const toRaw = (str) => `R"EOF(\n${str}\n)EOF"`;

  const cert = fs.readFileSync(certPath, "utf8");
  const key = fs.readFileSync(keyPath, "utf8");
  const ca = fs.readFileSync(caPath, "utf8");
  const pub = fs.readFileSync(pubPath, "utf8");

  const firmwareUrl = `https://your-bucket-name.s3.ap-south-1.amazonaws.com/${thingName}/firmware.bin`;
  const configUrl = `https://your-bucket-name.s3.ap-south-1.amazonaws.com/${thingName}/config.json`;

  const headerContent = `
#ifndef ${thingName.toUpperCase()}_H
#define ${thingName.toUpperCase()}_H

const char* rootCAcertificate = ${toRaw(ca)};
const char* clientcertificate = ${toRaw(cert)};
const char* clientprivatekey = ${toRaw(key)};
const char* clientpublickey = ${toRaw(pub)};
const char* s3_url_1 = "${firmwareUrl}";
const char* s3_url_2 = "${configUrl}";

#endif // ${thingName.toUpperCase()}_H
`.trim();

  const headerPath = path.join(__dirname, "certs", `${thingName}.h`);
  fs.writeFileSync(headerPath, headerContent);

  return headerPath;
}

function listThingsByPrefix(prefix) {
  return new Promise((resolve, reject) => {
    exec("aws iot list-things", (err, stdout) => {
      if (err) return reject(err);
      try {
        const data = JSON.parse(stdout);
        const matching = data.things
          .map(t => t.thingName)
          .filter(name => name.startsWith(prefix));
        resolve(matching);
      } catch (e) {
        reject(e);
      }
    });
  });
}

app.get("/api/get-models", (req, res) => {
  try {
    const models = getModels();
    res.json(models);
  } catch {
    res.status(500).send("❌ Failed to load models");
  }
});

app.post("/api/add-model", (req, res) => {
  const { type, modelKey} = req.body;
  if (!type || !modelKey) {
    return res.status(400).send("❌ Invalid model data");
  }

  const models = getModels();
  models[type] = models[type] || {}

  fs.writeFileSync(modelsFile, JSON.stringify(models, null, 2));
  res.send("✅ Model added");
});

app.post("/api/next-range", async (req, res) => {
  const { type, baseModel, tankModel, count } = req.body;
  const models = getModels();
  const modelMap = type === "Base" ? models.Base : models.Tank;

  if (!type || !count || !modelMap || (type === "Base" && !baseModel) || (type === "Tank" && !tankModel)) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const modelKey = type === "Base" ? baseModel : tankModel;
  const prefix = modelMap[modelKey];
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
    const start = maxId + 1;
    const end = start + count - 1;
    const startId = `${prefix}${dateCode}A${pad(start)}`;
    const endId = `${prefix}${dateCode}A${pad(end)}`;

    res.json({ range: `${startId} to ${endId}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal error" });
  }
});

app.post("/create", async (req, res) => {
  const { type, baseModel, tankModel, count, user } = req.body;
  const models = getModels();
  const modelKey = type === "Tank" ? tankModel : baseModel;
  const modelMap = type === "Tank" ? models.Tank : models.Base;
  const prefix = modelMap[modelKey];

  if (!type || !count || !prefix) {
    return res.status(400).send("Invalid input");
  }

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

    await Promise.all(
      newThings.map(name =>
        execPromise(`bash ./create-iot-thing.sh ${name} ${type} ${modelKey}`)
      )
    );

    setTimeout(() => {
      newThings.forEach(name => {
        const certDir = path.join(__dirname, "certs", name);
        try {
          generateHeaderFile(name, certDir);
        } catch (e) {
          console.error(`Header generation failed for ${name}:`, e);
        }
      });

      const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile)) : [];
      const newHistory = newThings.map(name => ({
        name,
        createdAt: new Date().toISOString(),
        user: user || "Unknown"
      }));
      fs.writeFileSync(historyFile, JSON.stringify([...history, ...newHistory], null, 2));
    }, 0);

    res.send(`✅ Created ${count} Thing(s):<ul>${newThings.map(n => `<li>${n}</li>`).join("")}</ul>`);
  } catch (err) {
    console.error("Create error:", err);
    res.status(500).send("Error creating one or more things.");
  }
});

app.get("/api/history", async (req, res) => {
  if (!fs.existsSync(historyFile)) return res.json([]);
  const history = JSON.parse(fs.readFileSync(historyFile));
  const verified = [];

  for (const entry of history) {
    try {
      await iot.describeThing({ thingName: entry.name }).promise();
      verified.push(entry);
    } catch {}
  }
  fs.writeFileSync(historyFile, JSON.stringify(verified, null, 2));
  res.json(verified);
});

app.post("/delete", async (req, res) => {
  const { thingName } = req.body;
  if (!thingName) return res.status(400).send("Missing thing name");

  try {
    await execPromise(`bash ./delete-iot-thing.sh ${thingName}`);
    const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile)) : [];
    const updated = history.filter(d => d.name !== thingName);
    fs.writeFileSync(historyFile, JSON.stringify(updated, null, 2));

    const certDir = path.join(__dirname, "certs", thingName);
    fs.rmSync(certDir, { recursive: true, force: true });

    res.send(`✅ Successfully Deleted ${thingName}`);
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).send("Error deleting the thing.");
  }
});

app.post("/delete-all", async (req, res) => {
  try {
    const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile)) : [];

    for (const entry of history) {
      const thingName = entry.name;
      try {
        await execPromise(`bash ./delete-iot-thing.sh ${thingName}`);
      } catch (err) {
        console.warn(`⚠️ Failed to delete ${thingName}:`, err.message);
      }

      const certDir = path.join(__dirname, "certs", thingName);
      const headerFile = path.join(__dirname, "certs", `${thingName}.h`);
      if (fs.existsSync(certDir)) fs.rmSync(certDir, { recursive: true, force: true });
      if (fs.existsSync(headerFile)) fs.rmSync(headerFile, { force: true });
    }

    fs.writeFileSync(historyFile, JSON.stringify([], null, 2));
    res.send("✅ All devices deleted.");
  } catch (err) {
    console.error("❌ Error in /delete-all:", err);
    res.status(500).send("❌ Failed to delete all devices.");
  }
});

app.post("/register", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).send("Missing credentials");
  const users = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile)) : [];
  if (users.find(u => u.username === username)) {
    return res.status(409).send("User already exists");
  }
  users.push({ username, password });
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
  res.send("✅ Registered successfully");
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const users = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile)) : [];
  const user = users.find(u => u.username === username && u.password === password);
  if (user) {
    res.send("✅ Login successful");
  } else {
    res.status(401).send("Invalid username or password");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
