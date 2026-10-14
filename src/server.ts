import express, {Request, Response, NextFunction} from 'express';
import multer from 'multer';
import {PrismaClient} from '@prisma/client';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {createReadStream, existsSync, mkdirSync} from 'node:fs';
import {basename, join} from 'node:path';

const prisma = new PrismaClient();
const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'local-admin-token-change-me';
const storageDir = join(process.cwd(), 'storage', 'firmware');
mkdirSync(storageDir, {recursive: true});
app.use(express.json({limit: '1mb'}));
app.use(express.static(join(process.cwd(), 'public')));
const upload = multer({dest: storageDir, limits: {fileSize: 100 * 1024 * 1024}});

type DeviceRequest = Request & { device?: { id: string } };

// In-memory marker: diagnostics received after the latest hello.
const diagnosticsReceived = new Set<string>();
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

function safeEqual(a: string, b: string) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

async function deviceAuth(req: DeviceRequest, res: Response, next: NextFunction) {
  const deviceId = String(req.header('x-device-id') || req.body?.deviceId || req.query.deviceId || '');
  const key = String(req.header('x-device-key') || req.body?.key || '');
  if (!deviceId || !key) return res.status(401).json({error: 'DEVICE_CREDENTIALS_REQUIRED'});
  const device = await prisma.device.findUnique({where: {id: deviceId}});
  if (!device || !safeEqual(device.keyHash, sha256(key))) {
    await prisma.deviceError.create({
      data: {
        deviceId: device?.id || `unknown-${deviceId}`.slice(0, 100),
        code: 'AUTH_FAILED',
        message: 'Invalid device ID or key'
      }
    }).catch(() => undefined);
    return res.status(401).json({error: 'INVALID_DEVICE_CREDENTIALS'});
  }
  await prisma.device.update({where: {id: deviceId}, data: {lastSeenAt: new Date()}});
  req.device = {id: deviceId};
  next();
}

function adminAuth(req: Request, res: Response, next: NextFunction) {
  const token = String(req.header('x-admin-token') || req.query.token || '');
  if (!safeEqual(token, ADMIN_TOKEN)) return res.status(401).json({error: 'ADMIN_AUTH_REQUIRED'});
  next();
}

const asyncRoute = (fn: (req: any, res: Response, next: NextFunction) => Promise<any>) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res, next)).catch(next);

// Device first checks in with its ID + shared key.
app.post('/api/device/hello', asyncRoute(async (req, res) => {
  const {deviceId, key} = req.body || {};
  if (!deviceId || !key) return res.status(400).json({error: 'deviceId_and_key_required'});
  const device = await prisma.device.findUnique({where: {id: String(deviceId)}});
  if (!device || !safeEqual(device.keyHash, sha256(String(key)))) {
    if (device) await prisma.deviceError.create({
      data: {
        deviceId: device.id,
        code: 'AUTH_FAILED',
        message: 'Invalid key during hello'
      }
    });
    return res.status(401).json({error: 'INVALID_DEVICE_CREDENTIALS'});
  }
  await prisma.device.update({where: {id: device.id}, data: {lastSeenAt: new Date()}});
  diagnosticsReceived.delete(device.id);
  return res.json({ok: true, deviceId: device.id, next: 'POST /api/device/diagnostics'});
}));

app.post('/api/device/diagnostics', deviceAuth, asyncRoute(async (req: DeviceRequest, res) => {
  const b = req.body || {};
  if (!b.model || !b.hardwareRev || !b.firmwareVersion || !b.status || !Number.isInteger(b.batteryPercent) || !Number.isInteger(b.uptimeSeconds)) {
    return res.status(400).json({
      error: 'DIAGNOSTICS_INCOMPLETE',
      required: ['model', 'hardwareRev', 'firmwareVersion', 'status', 'batteryPercent(integer)', 'uptimeSeconds(integer)']
    });
  }
  const data = {
    model: String(b.model),
    hardwareRev: String(b.hardwareRev),
    firmwareVersion: String(b.firmwareVersion),
    status: String(b.status),
    batteryPercent: Math.max(0, Math.min(100, Number(b.batteryPercent))),
    uptimeSeconds: Math.max(0, Number(b.uptimeSeconds)),
    diagnosticsJson: JSON.stringify(b.extra ?? {}),
    lastDiagnosticAt: new Date()
  };
  await prisma.device.update({where: {id: req.device!.id}, data});
  diagnosticsReceived.add(req.device!.id);

  if (Array.isArray(b.errors)) for (const e of b.errors) await prisma.deviceError.create({
    data: {
      deviceId: req.device!.id,
      code: String(e.code || 'DEVICE_ERROR'),
      message: String(e.message || 'Unspecified device error'),
      detailsJson: JSON.stringify(e.details ?? {})
    }
  });
  res.json({ok: true, receivedAt: new Date().toISOString(), diagnosticsAccepted: true});
}));

app.get('/api/device/update-check', deviceAuth, asyncRoute(async (req: DeviceRequest, res) => {
  const device = await prisma.device.findUnique({where: {id: req.device!.id}});
  // Never offer firmware until this device has supplied diagnostics.
  if (
    !device ||
    !diagnosticsReceived.has(device.id) ||
    !device.lastDiagnosticAt ||
    !device.model ||
    !device.hardwareRev ||
    !device.firmwareVersion
  ) {
    return res.status(409).json({
      error: 'DIAGNOSTICS_REQUIRED',
      updateAvailable: false
    });
  }
  const candidate = await findNewestCompatibleFirmware(
    device.model,
    device.hardwareRev,
    device.firmwareVersion
  );
  if (!candidate) return res.json({updateAvailable: false, currentVersion: device.firmwareVersion});
  const session = await prisma.updateSession.create({
    data: {
      deviceId: device.id,
      firmwareId: candidate.id,
      status: 'OFFERED'
    }
  });
  res.json({
    updateAvailable: true,
    updateId: session.id,
    version: candidate.version,
    changelog: candidate.changelog,
    sizeBytes: candidate.sizeBytes,
    sha256: candidate.sha256,
    confirmUrl: `/api/device/updates/${session.id}/confirm`
  });
}));

app.post('/api/device/updates/:id/confirm', deviceAuth, asyncRoute(async (req: DeviceRequest, res) => {
  const session = await prisma.updateSession.findFirst({
    where: {id: String(req.params.id), deviceId: req.device!.id},
    include: {firmware: true}
  });
  if (!session || session.status !== 'OFFERED') return res.status(404).json({error: 'UPDATE_NOT_AVAILABLE'});
  await prisma.updateSession.update({where: {id: session.id}, data: {status: 'CONFIRMED', confirmedAt: new Date()}});
  res.json({
    ok: true,
    downloadUrl: `/api/device/updates/${session.id}/download`,
    sha256: session.firmware.sha256,
    sizeBytes: session.firmware.sizeBytes
  });
}));

app.get('/api/device/updates/:id/download', deviceAuth, asyncRoute(async (req: DeviceRequest, res) => {
  const session = await prisma.updateSession.findFirst({
    where: {id: String(req.params.id), deviceId: req.device!.id},
    include: {firmware: true}
  });
  if (!session || !['CONFIRMED', 'DOWNLOADING'].includes(session.status)) return res.status(409).json({error: 'UPDATE_NOT_CONFIRMED'});
  const path = join(storageDir, session.firmware.storedFilename);
  if (!existsSync(path)) return res.status(410).json({error: 'FIRMWARE_FILE_MISSING'});
  await prisma.updateSession.update({where: {id: session.id}, data: {status: 'DOWNLOADING'}});
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${basename(session.firmware.filename)}"`);
  createReadStream(path).pipe(res);
}));

app.post('/api/device/updates/:id/result', deviceAuth, asyncRoute(async (req: DeviceRequest, res) => {
  const {result, message, firmwareVersion} = req.body || {};
  if (!['SUCCESS', 'INTEGRITY_ERROR', 'INSTALL_ERROR', 'DOWNLOAD_ERROR'].includes(result)) return res.status(400).json({error: 'INVALID_RESULT'});
  const session = await prisma.updateSession.findFirst({where: {id: String(req.params.id), deviceId: req.device!.id}});
  if (!session) return res.status(404).json({error: 'UPDATE_NOT_FOUND'});
  const success = result === 'SUCCESS';
  await prisma.updateSession.update({
    where: {id: session.id},
    data: {status: result, errorMessage: message ? String(message) : null, finishedAt: new Date()}
  });
  if (success && firmwareVersion) await prisma.device.update({
    where: {id: req.device!.id},
    data: {firmwareVersion: String(firmwareVersion)}
  });
  if (!success) await prisma.deviceError.create({
    data: {
      deviceId: req.device!.id,
      code: result,
      message: String(message || result),
      detailsJson: JSON.stringify({updateId: session.id})
    }
  });
  res.json({ok: true, recorded: result});
}));

// Admin API. All /api/admin endpoints require x-admin-token.
app.get('/api/admin/devices', adminAuth, asyncRoute(async (_req, res) => {
  res.json(await prisma.device.findMany({
    orderBy: {lastSeenAt: 'desc'},
    include: {
      errors: {orderBy: {createdAt: 'desc'}, take: 3},
      updates: {orderBy: {offeredAt: 'desc'}, take: 3, include: {firmware: true}}
    }
  }));
}));
app.get('/api/admin/firmware', adminAuth, asyncRoute(async (_req, res) => res.json(await prisma.firmware.findMany({orderBy: {createdAt: 'desc'}}))));
app.get('/api/admin/events', adminAuth, asyncRoute(async (_req, res) => {
  const [errors, updates] = await Promise.all([prisma.deviceError.findMany({
    orderBy: {createdAt: 'desc'},
    take: 100,
    include: {device: {select: {id: true}}}
  }), prisma.updateSession.findMany({
    orderBy: {offeredAt: 'desc'},
    take: 100,
    include: {device: {select: {id: true}}, firmware: true}
  })]);
  res.json({errors, updates});
}));
app.post('/api/admin/devices', adminAuth, asyncRoute(async (req, res) => {
  const {id, key, model, hardwareRev} = req.body || {};
  if (!id || !key) return res.status(400).json({error: 'id_and_key_required'});
  if ((model && !hardwareRev) || (!model && hardwareRev)) {
    return res.status(400).json({error: 'model_and_hardwareRev_must_be_provided_together'});
  }
  const device = await prisma.device.create({
    data: {
      id: String(id),
      keyHash: sha256(String(key)),
      model: model ? String(model) : null,
      hardwareRev: hardwareRev ? String(hardwareRev) : null
    }
  });
  res.status(201).json({id: device.id, created: true});
}));
app.post('/api/admin/firmware', adminAuth, upload.single('file'), asyncRoute(async (req: Request, res) => {
  const file = (req as any).file as Express.Multer.File | undefined;
  const {version, model, hardwareRev, changelog} = req.body || {};
  if (!file || !version || !model || !hardwareRev || !changelog) {
    if (file) await import('node:fs/promises').then(fs => fs.unlink(file.path).catch(() => undefined));
    return res.status(400).json({error: 'file_version_model_hardwareRev_changelog_required'});
  }
  const storedFilename = `${randomBytes(8).toString('hex')}-${basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const finalPath = join(storageDir, storedFilename);
  await import('node:fs/promises').then(fs => fs.rename(file.path, finalPath));
  const fw = await prisma.firmware.create({
    data: {
      version: String(version),
      model: String(model),
      hardwareRev: String(hardwareRev),
      changelog: String(changelog),
      filename: basename(file.originalname),
      storedFilename,
      sha256: sha256(await import('node:fs/promises').then(fs => fs.readFile(finalPath))),
      sizeBytes: file.size
    }
  });
  res.status(201).json(fw);
}));
app.delete('/api/admin/firmware/:id', adminAuth, asyncRoute(async (req, res) => {
  const fw = await prisma.firmware.findUnique({where: {id: String(req.params.id)}});
  if (!fw) return res.status(404).json({error: 'FIRMWARE_NOT_FOUND'});
  await prisma.firmware.delete({where: {id: fw.id}});
  await import('node:fs/promises').then(fs => fs.unlink(join(storageDir, fw.storedFilename)).catch(() => undefined));
  res.json({ok: true});
}));

type TestScenario =
  | 'SUCCESS'
  | 'NO_UPDATE'
  | 'BAD_KEY'
  | 'NO_DIAGNOSTICS'
  | 'DISCONNECT'
  | 'CORRUPT_FILE'
  | 'INSTALL_ERROR'
  | 'DEVICE_ERROR'
  | 'CHECK_UPDATE'
  | 'SET_FIRMWARE_VERSION';

const testScenarios = new Set<TestScenario>([
  'SUCCESS', 'NO_UPDATE', 'BAD_KEY', 'NO_DIAGNOSTICS',
  'DISCONNECT', 'CORRUPT_FILE', 'INSTALL_ERROR', 'DEVICE_ERROR',
  'CHECK_UPDATE', 'SET_FIRMWARE_VERSION'
]);

function testError(deviceId: string, code: string, message: string, details: Record<string, string> = {}) {
  return prisma.deviceError.create({
    data: {deviceId, code, message, detailsJson: JSON.stringify(details)}
  });
}

app.post('/api/admin/test-runs', adminAuth, asyncRoute(async (req, res) => {
  const {deviceId, firmwareId, firmwareVersion, scenario} = req.body || {};
  if (!deviceId || !scenario) {
    return res.status(400).json({error: 'deviceId_and_scenario_required'});
  }
  if (!testScenarios.has(scenario as TestScenario)) {
    return res.status(400).json({error: 'INVALID_TEST_SCENARIO'});
  }

  const device = await prisma.device.findUnique({where: {id: String(deviceId)}});
  if (!device) return res.status(404).json({error: 'DEVICE_NOT_FOUND'});

  const selectedScenario = scenario as TestScenario;
  if (selectedScenario === 'SET_FIRMWARE_VERSION') {
    const version = String(firmwareVersion || '').trim();
    if (!version) return res.status(400).json({error: 'firmwareVersion_required'});
    await prisma.device.update({
      where: {id: device.id},
      data: {firmwareVersion: version, lastSeenAt: new Date()}
    });
    return res.json({
      status: 'FIRMWARE_VERSION_SET',
      currentVersion: version,
      message: `Поточну версію пристрою змінено на ${version}.`
    });
  }
  if (selectedScenario === 'CHECK_UPDATE') {
    if (!device.model || !device.hardwareRev) {
      return res.json({status: 'DIAGNOSTICS_REQUIRED', message: 'Для перевірки оновлень потрібні модель і ревізія пристрою.'});
    }
    const currentVersion = device.firmwareVersion || '0.0.0';
    await prisma.device.update({
      where: {id: device.id},
      data: {lastSeenAt: new Date(), lastDiagnosticAt: new Date(), status: device.status === 'UNKNOWN' ? 'OK' : device.status}
    });
    const candidate = await findNewestCompatibleFirmware(device.model, device.hardwareRev, currentVersion);
    if (!candidate) {
      return res.json({status: 'NO_UPDATE', currentVersion, message: 'Новішої сумісної прошивки для пристрою немає.'});
    }
    return res.json({
      status: 'UPDATE_AVAILABLE',
      currentVersion,
      availableVersion: candidate.version,
      firmwareId: candidate.id,
      message: `Доступна новіша сумісна прошивка ${candidate.version}.`
    });
  }
  if (!firmwareId) return res.status(400).json({error: 'firmwareId_required'});
  const firmware = await prisma.firmware.findUnique({where: {id: String(firmwareId)}});
  if (!firmware) return res.status(404).json({error: 'FIRMWARE_NOT_FOUND'});

  const matchingHardware = device.model === firmware.model && device.hardwareRev === firmware.hardwareRev;
  const context = {firmwareId: firmware.id, firmwareVersion: firmware.version};

  if (selectedScenario === 'BAD_KEY') {
    await testError(device.id, 'AUTH_FAILED', 'Імітація відхиленого неправильного ключа', context);
    return res.json({status: 'AUTH_FAILED', message: 'Сервер відхилив запит із неправильним ключем.'});
  }
  if (selectedScenario === 'NO_DIAGNOSTICS') {
    await prisma.device.update({where: {id: device.id}, data: {lastSeenAt: new Date()}});
    return res.json({
      status: 'DIAGNOSTICS_REQUIRED',
      message: 'Оновлення не запропоновано, бо діагностику не отримано.'
    });
  }
  // Every other frontend scenario starts with the device supplying its stored diagnostics.
  await prisma.device.update({
    where: {id: device.id},
    data: {
      lastSeenAt: new Date(),
      lastDiagnosticAt: new Date(),
      status: device.status === 'UNKNOWN' ? 'OK' : device.status
    }
  });
  if (selectedScenario === 'DISCONNECT') {
    return res.json({
      status: 'DISCONNECTED',
      message: 'Пристрій припинив зв’язок після діагностики, до перевірки сумісності прошивки.'
    });
  }
  if (!matchingHardware) {
    return res.json({
      status: 'INCOMPATIBLE_FIRMWARE',
      message: 'Прошивка не сумісна з моделлю або ревізією пристрою.'
    });
  }
  if (selectedScenario === 'NO_UPDATE') {
    return res.json({status: 'NO_UPDATE', message: 'Новішої сумісної прошивки для пристрою немає.'});
  }

  const update = await prisma.updateSession.create({
    data: {deviceId: device.id, firmwareId: firmware.id, status: 'OFFERED'}
  });
  await prisma.updateSession.update({
    where: {id: update.id},
    data: {status: 'CONFIRMED', confirmedAt: new Date()}
  });
  if (selectedScenario === 'CORRUPT_FILE') {
    await prisma.updateSession.update({
      where: {id: update.id},
      data: {status: 'INTEGRITY_ERROR', errorMessage: 'Імітація невідповідності SHA-256', finishedAt: new Date()}
    });
    await testError(device.id, 'INTEGRITY_ERROR', 'Контрольна сума завантаженого файла не збігається', context);
    return res.json({status: 'INTEGRITY_ERROR', updateId: update.id, message: 'Виявлено пошкодження файла прошивки.'});
  }
  if (selectedScenario === 'INSTALL_ERROR') {
    await prisma.updateSession.update({
      where: {id: update.id},
      data: {status: 'INSTALL_ERROR', errorMessage: 'Імітація помилки встановлення', finishedAt: new Date()}
    });
    await testError(device.id, 'INSTALL_ERROR', 'Імітація помилки встановлення прошивки', context);
    return res.json({
      status: 'INSTALL_ERROR',
      updateId: update.id,
      message: 'Пристрій повідомив про помилку встановлення.'
    });
  }
  if (selectedScenario === 'DEVICE_ERROR') {
    await testError(device.id, 'E_SENSOR_WARN', 'Імітація попередження датчика перед оновленням', context);
  }
  await prisma.updateSession.update({
    where: {id: update.id},
    data: {status: 'SUCCESS', finishedAt: new Date()}
  });
  await prisma.device.update({
    where: {id: device.id},
    data: {firmwareVersion: firmware.version, lastSeenAt: new Date()}
  });
  return res.json({
    status: 'SUCCESS',
    updateId: update.id,
    message: selectedScenario === 'DEVICE_ERROR'
      ? 'Попередження пристрою збережено; оновлення завершено успішно.'
      : 'Оновлення успішно змодельовано.'
  });
}));
app.get('/api/health', (_req, res) => res.json({ok: true}));
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({error: 'INTERNAL_SERVER_ERROR', message: err?.message || 'Unknown error'});
});

function compareVersion(a: string, b: string) {
  const pa = a.split(/[.-]/).map(x => Number(x) || 0);
  const pb = b.split(/[.-]/).map(x => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function findNewestCompatibleFirmware(model: string, hardwareRev: string, currentVersion: string) {
  const versions = await prisma.firmware.findMany({where: {model, hardwareRev}});
  return versions
    .filter(firmware => compareVersion(firmware.version, currentVersion) > 0)
    .sort((a, b) => compareVersion(b.version, a.version))[0];
}

app.listen(PORT, () => console.log(`Firmware lab listening at http://localhost:${PORT}`));
