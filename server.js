const express = require("express");
const bodyParser = require("body-parser");
const { exec } = require("child_process");
const fs = require("fs-extra");
const path = require("path");
const util = require("util");
const AWS = require("aws-sdk");
const execPromise = util.promisify(exec);
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = 80;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static("public"));
app.use(express.json());
app.use("/certs", express.static(path.join(__dirname, "certs")));

AWS.config.update({ region: "ap-south-1" });


const iotData = new AWS.IotData({ endpoint: "a1r6z29mxc63px-ats.iot.ap-south-1.amazonaws.com" });

const POLICY_NAME = "IOTIQ_IoTPolicy";

const historyFile = path.join(__dirname, "history.json");
const usersFile = path.join(__dirname, "users.json");
const modelsFile = path.join(__dirname, "models.json");

const generateHFile = async (data, fileName) => {
  const filePath = path.join(__dirname, "generated_h_files", `${fileName}.h`);
  const content = `
String ThingId="${data.thingName}";
String DeviceId="${data.deviceId}";
String BLE_name="${data.bleName}";
String Secret="${data.secret}";
String Mqtt_server="${data.endpoint}";
String OTA_host="";
String FirmwareVer = "1.0.0";
String Access_token = "";
String ssid = "ACS-4G";
String password = "Acs@$2025";
String Version_device="";
bool versionflag = false;
String Lora_data="";
bool Lora_flag=0;
bool motor1_flag;
bool motor2_flag;

const {
  IoTClient,
  DetachThingPrincipalCommand,
  ListThingPrincipalsCommand,
  DeleteThingCommand,
  ListThingCertificatesCommand,
  DeleteCertificateCommand,
  UpdateCertificateCommand,
  ListAttachedPoliciesCommand,
  DetachPolicyCommand,
  ListCertificatesCommand,
  DeletePolicyCommand,
} = require("@aws-sdk/client-iot");

const iot = new IoTClient({ region: "ap-south-1" }); // use your region

// Root CA, Client Certificate, and Client Private Key
String rootCACertificate = R"EOF(${data.rootCA})EOF";
String clientCertificate = R"KEY(${data.certPem})KEY";
String clientPrivateKey = R"KEY(${data.privateKey})KEY";
`;

  await fs.writeFile(filePath, content);
  return filePath;
};

// At top of server.js
const {
  IoTClient,
  CreateThingCommand,
  CreateKeysAndCertificateCommand,
  AttachThingPrincipalCommand,
  AttachPolicyCommand
} = require("@aws-sdk/client-iot");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const iot = new IoTClient({ region: "ap-south-1" });
const s3 = new S3Client({ region: "ap-south-1" });

async function createIotThing(name, type, model) {
  const policyName = "IOTIQPolicy"; // Replace with your actual policy name

  // Step 1: Create Thing
  await iot.send(new CreateThingCommand({ thingName: name }));

  // Step 2: Create certs
  const { certificateArn, certificateId, certificatePem, keyPair } = await iot.send(
    new CreateKeysAndCertificateCommand({ setAsActive: true })
  );

  // Step 3: Attach cert to Thing
  await iot.send(new AttachThingPrincipalCommand({
    thingName: name,
    principal: certificateArn
  }));

  // Step 4: Attach Policy
  await iot.send(new AttachPolicyCommand({
    policyName,
    target: certificateArn
  }));

  // Step 5: Save certs locally
  const certDir = path.join(__dirname, "certs", name);
  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(path.join(certDir, "cert.pem"), certificatePem);
  fs.writeFileSync(path.join(certDir, "private.key"), keyPair.PrivateKey);
  fs.writeFileSync(path.join(certDir, "public.key"), keyPair.PublicKey);

  // Step 6: Download S3 files (if needed)
  await downloadFromS3("iotiq-firmware", "firmware.bin", path.join(certDir, "firmware.bin"));
  await downloadFromS3("iotiq-config", "config.json", path.join(certDir, "config.json"));

  // Step 7: Generate `.h` file
  generateHFile(name, certDir);
}

async function downloadFromS3(bucket, key, filePath) {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const data = await s3.send(command);
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(filePath);
    data.Body.pipe(stream);
    data.Body.on("end", resolve);
    data.Body.on("error", reject);
  });
}

const {
  DeleteThingCommand,
  ListThingPrincipalsCommand,
  DetachThingPrincipalCommand,
  DetachPolicyCommand,
  DeleteCertificateCommand,
  UpdateCertificateCommand,
} = require("@aws-sdk/client-iot");

async function deleteThingAndCert(thingName) {
  const principals = await iotClient.send(new ListThingPrincipalsCommand({ thingName }));

  for (const principal of principals.principals || []) {
    // Detach from Thing
    await iotClient.send(new DetachThingPrincipalCommand({ thingName, principal }));

    // Detach Policies
    await iotClient.send(new DetachPolicyCommand({ policyName: "IOTIQ_IoTPolicy", target: principal }));

    // Disable Cert
    const certId = principal.split("/")[1];
    await iotClient.send(new UpdateCertificateCommand({ certificateId: certId, newStatus: "INACTIVE" }));

    // Delete Cert
    await iotClient.send(new DeleteCertificateCommand({ certificateId: certId, forceDelete: true }));
  }

  // Delete Thing
  await iotClient.send(new DeleteThingCommand({ thingName }));
}

async function deleteThingByName(thingName) {
  // 1. Get attached principals
  const principalsRes = await iot.send(new ListThingPrincipalsCommand({ thingName }));
  const principals = principalsRes.principals || [];

  for (const principal of principals) {
    // Detach policies
    const policiesRes = await iot.send(new ListAttachedPoliciesCommand({ target: principal }));
    const policies = policiesRes.policies || [];
    for (const policy of policies) {
if (policies && policies.length > 0) {
  for (const policy of policies) {
    await iot.send(new DetachPolicyCommand({ policyName: policy.policyName, target: principal }));
  }
}
    }

    // Detach principal from Thing
    await iot.send(new DetachThingPrincipalCommand({ thingName, principal }));

    // Extract certificate ID
    const certId = principal.split("/").pop();

    // Deactivate cert (required before deletion)
    await iot.send(new UpdateCertificateCommand({ certificateId: certId, newStatus: "INACTIVE" }));

    // Delete certificate
    await iot.send(new DeleteCertificateCommand({ certificateId: certId, forceDelete: true }));
  }

  // Delete Thing
  await iot.send(new DeleteThingCommand({ thingName }));
}

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

// function generateHeaderFile(thingName, certDir) {
//   const certPath = path.join(certDir, "certificate.pem.crt");
//   const keyPath = path.join(certDir, "private.pem.key");
//   const caPath = path.join(certDir, "AmazonRootCA1.pem");
//   const pubPath = path.join(certDir, "public.pem.key");

//   if (!fs.existsSync(certPath) || !fs.existsSync(keyPath) || !fs.existsSync(caPath) || !fs.existsSync(pubPath)) {
//     throw new Error(`Missing certificate files for ${thingName}`);
//   }

//   const toRaw = (str) => `R"EOF(\n${str}\n)EOF"`;

//   const cert = fs.readFileSync(certPath, "utf8");
//   const key = fs.readFileSync(keyPath, "utf8");
//   const ca = fs.readFileSync(caPath, "utf8");
//   const pub = fs.readFileSync(pubPath, "utf8");

//   const firmwareUrl = `https://your-bucket-name.s3.ap-south-1.amazonaws.com/${thingName}/firmware.bin`;
//   const configUrl = `https://your-bucket-name.s3.ap-south-1.amazonaws.com/${thingName}/config.json`;

//   const headerContent = `
// #ifndef ${thingName.toUpperCase()}_H
// #define ${thingName.toUpperCase()}_H

// const char* rootCAcertificate = ${toRaw(ca)};
// const char* clientcertificate = ${toRaw(cert)};
// const char* clientprivatekey = ${toRaw(key)};
// const char* clientpublickey = ${toRaw(pub)};
// const char* s3_url_1 = "${firmwareUrl}";
// const char* s3_url_2 = "${configUrl}";

// #endif // ${thingName.toUpperCase()}_H
// `.trim();

//   const headerPath = path.join(__dirname, "certs", `${thingName}.h`);
//   fs.writeFileSync(headerPath, headerContent);

//   return headerPath;
// }

const { ListThingsCommand } = require("@aws-sdk/client-iot");

async function listThingsByPrefix(prefix) {
  let things = [];
  let nextToken;
  do {
    const response = await iot.send(new ListThingsCommand({ nextToken }));
    things = things.concat(response.things || []);
    nextToken = response.nextToken;
  } while (nextToken);

  return things
    .map(t => t.thingName)
    .filter(name => name.startsWith(prefix));
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
  models[type] = models[type] || {};

  if (models[type][modelKey]) {
  return res.status(409).send("❌ Model already exists");
}
models[type][modelKey] = "";
  fs.writeFileSync(modelsFile, JSON.stringify(models, null, 2));
  res.send("✅ Model added");
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
       newThings.map(name => createIotThing(name, type, modelKey))
    );

    setTimeout(() => {
      newThings.forEach(name => {
        const certDir = path.join(__dirname, "certs", name);
        try {
          generateHFile(name, certDir);
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
    await deleteThingByName(thingName);
    const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile)) : [];
    const updated = history.filter(d => d.name !== thingName);
    fs.writeFileSync(historyFile, JSON.stringify(updated, null, 2));

    const certDir = path.join(__dirname, "certs", thingName);
    const headerFile = path.join(__dirname, "certs", `${thingName}.h`);

    if (fs.existsSync(certDir)) fs.rmSync(certDir, { recursive: true, force: true });
    if (fs.existsSync(headerFile)) fs.rmSync(headerFile, { force: true });

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
        await deleteThingByName(thingName);
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
