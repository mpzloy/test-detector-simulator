import {FormEvent, useEffect, useMemo, useState} from 'react';

type DeviceError = { code: string; message: string; createdAt: string };
type Firmware = {
  id: string; version: string; model: string; hardwareRev: string; changelog: string;
  filename: string; sizeBytes: number; sha256: string; createdAt: string;
};
type Device = {
  id: string; model: string | null; hardwareRev: string | null; firmwareVersion: string | null;
  status: string; batteryPercent: number | null; lastSeenAt: string | null; lastDiagnosticAt: string | null;
  errors: DeviceError[];
};
type Update = {
  id: string; status: string; offeredAt: string; errorMessage: string | null;
  device: { id: string }; firmware: { version: string };
};
type EventData = { errors: Array<DeviceError & { deviceId: string }>; updates: Update[] };

const scenarios = [
  ['SUCCESS', 'Успішне оновлення', 'Сумісний новіший файл завантажено й встановлено.'],
  ['NO_UPDATE', 'Оновлення немає', 'Для пристрою немає новішої сумісної версії.'],
  ['BAD_KEY', 'Неправильний ключ', 'Сервер відхиляє пристрій під час автентифікації.'],
  ['NO_DIAGNOSTICS', 'Немає діагностики', 'Оновлення заборонене до надсилання діагностики.'],
  ['DISCONNECT', 'Втрачено зв’язок', 'Пристрій припиняє обмін після діагностики, до перевірки прошивки.'],
  ['CORRUPT_FILE', 'Пошкоджений файл', 'SHA-256 не збігається після завантаження.'],
  ['INSTALL_ERROR', 'Помилка встановлення', 'Пристрій не може застосувати прошивку.'],
  ['DEVICE_ERROR', 'Попередження пристрою', 'Помилка датчика записується, оновлення завершується.'],
  ['CHECK_UPDATE', 'Перевірити нову версію', 'Показує поточну й найновішу сумісну версію без створення сесії оновлення.'],
  ['SET_FIRMWARE_VERSION', 'Задати поточну версію', 'Перезаписує поточну версію пристрою для наступної перевірки оновлень.']
] as const;

const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString('uk-UA') : '—';
const compatibility = (device: Device, firmware: Firmware) =>
  device.model === firmware.model && device.hardwareRev === firmware.hardwareRev;

export function App() {
  const [token, setToken] = useState('local-admin-token-change-me');
  const [devices, setDevices] = useState<Device[]>([]);
  const [firmware, setFirmware] = useState<Firmware[]>([]);
  const [events, setEvents] = useState<EventData>({errors: [], updates: []});
  const [message, setMessage] = useState('Завантаження даних…');
  const [deviceId, setDeviceId] = useState('');
  const [firmwareId, setFirmwareId] = useState('');
  const [scenario, setScenario] = useState<(typeof scenarios)[number][0]>('SUCCESS');
  const [firmwareVersion, setFirmwareVersion] = useState('');
  const [running, setRunning] = useState(false);

  async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
      ...options,
      headers: {'x-admin-token': token, ...options.headers}
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || response.statusText);
    return body;
  }

  async function refresh() {
    try {
      setMessage('Завантаження даних…');
      const [nextDevices, nextFirmware, nextEvents] = await Promise.all([
        api<Device[]>('/api/admin/devices'),
        api<Firmware[]>('/api/admin/firmware'),
        api<EventData>('/api/admin/events')
      ]);
      setDevices(nextDevices);
      setFirmware(nextFirmware);
      setDeviceId(current => nextDevices.some(device => device.id === current) ? current : nextDevices[0]?.id || '');
      setFirmwareId(current => nextFirmware.some(item => item.id === current) ? current : nextFirmware[0]?.id || '');
      setEvents(nextEvents);
      setMessage('Дані оновлено.');
    } catch (error) {
      setMessage(`Помилка: ${(error as Error).message}`);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const selectedDevice = useMemo(() => devices.find(device => device.id === deviceId), [devices, deviceId]);
  const selectedFirmware = useMemo(() => firmware.find(item => item.id === firmwareId), [firmware, firmwareId]);
  const requiresFirmware = !['CHECK_UPDATE', 'SET_FIRMWARE_VERSION'].includes(scenario);
  const firmwareOptions = useMemo(() => {
    if (scenario !== 'CHECK_UPDATE' || !selectedDevice) return firmware;
    return firmware
      .filter(item => compatibility(selectedDevice, item))
      .sort((first, second) => second.version.localeCompare(first.version, undefined, {numeric: true}));
  }, [firmware, scenario, selectedDevice]);

  useEffect(() => {
    if (scenario !== 'CHECK_UPDATE') return;
    if (firmwareOptions.some(item => item.id === firmwareId)) return;
    setFirmwareId(firmwareOptions[0]?.id || '');
  }, [firmwareId, firmwareOptions, scenario]);

  async function addDevice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await api('/api/admin/devices', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(Object.fromEntries(form))
      });
      formElement.reset();
      await refresh();
      setMessage('Пристрій створено.');
    } catch (error) {
      setMessage(`Помилка створення пристрою: ${(error as Error).message}`);
    }
  }

  async function uploadFirmware(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    try {
      const response = await fetch('/api/admin/firmware', {
        method: 'POST',
        headers: {'x-admin-token': token},
        body: new FormData(formElement)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || response.statusText);
      formElement.reset();
      await refresh();
      setMessage('Прошивку завантажено.');
    } catch (error) {
      setMessage(`Помилка завантаження: ${(error as Error).message}`);
    }
  }

  async function runTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deviceId || (requiresFirmware && !firmwareId) || (scenario === 'SET_FIRMWARE_VERSION' && !firmwareVersion.trim())) return;
    setRunning(true);
    try {
      const result = await api<{ status: string; message: string; currentVersion?: string; availableVersion?: string }>('/api/admin/test-runs', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          deviceId,
          scenario,
          ...(requiresFirmware ? {firmwareId} : {}),
          ...(scenario === 'SET_FIRMWARE_VERSION' ? {firmwareVersion: firmwareVersion.trim()} : {})
        })
      });
      await refresh();
      const versions = result.currentVersion
        ? ` Поточна версія: ${result.currentVersion}.${result.availableVersion ? ` Доступна: ${result.availableVersion}.` : ''}`
        : '';
      setMessage(`${result.status}: ${result.message}${versions}`);
    } catch (error) {
      setMessage(`Помилка запуску тесту: ${(error as Error).message}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 text-slate-800 sm:px-6">
      <header
        className="mb-8 flex flex-col gap-4 border-b border-slate-200 pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="mb-2 text-sm font-semibold uppercase tracking-[0.18em] text-indigo-600">Локальний стенд</p>
          <h1 className="text-3xl font-bold tracking-tight text-slate-950">Firmware Update Lab</h1>
          <p className="mt-2 text-slate-600">Адмінка, сумісність прошивок і сценарії оновлення без консолі.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="field grow">Токен адміністратора
            <input value={token} onChange={event => setToken(event.target.value)} autoComplete="off"/>
          </label>
          <button type="button" className="button-secondary" onClick={() => void refresh()}>Оновити</button>
        </div>
      </header>

      <p role="status"
         className="mb-6 rounded-lg border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-950">{message}</p>

      <section className="mb-6 grid gap-6 lg:grid-cols-2">
        <Panel title="Додати пристрій">
          <form className="form-grid" onSubmit={addDevice}>
            <label className="field">ID пристрою<input name="id" placeholder="detector-002" required/></label>
            <label className="field">Секретний ключ<input name="key" type="password" placeholder="Ключ пристрою"
                                                          required/></label>
            <label className="field">Модель<input name="model" placeholder="D-100" required/></label>
            <label className="field">Ревізія заліза<input name="hardwareRev" placeholder="rev-A" required/></label>
            <button className="button-primary col-span-full sm:col-span-1">Створити пристрій</button>
          </form>
          <p className="hint">ID і ключ потрібні для автентифікації, а модель і ревізія — для перевірки сумісності.</p>
        </Panel>
        <Panel title="Завантажити прошивку">
          <form className="form-grid" onSubmit={uploadFirmware}>
            <label className="field">Версія<input name="version" placeholder="1.2.0" required/></label>
            <label className="field">Модель<input name="model" placeholder="D-100" required/></label>
            <label className="field">Ревізія заліза<input name="hardwareRev" placeholder="rev-A" required/></label>
            <label className="field">Файл<input name="file" type="file" required/></label>
            <label className="field col-span-full">Опис змін<textarea name="changelog" placeholder="Що змінилось"
                                                                      required/></label>
            <button className="button-primary col-span-full sm:col-span-1">Завантажити прошивку</button>
          </form>
        </Panel>
      </section>

      <section className="mb-6">
        <Panel title="Запустити тест оновлення"
               description="Оберіть пристрій, конкретну прошивку та сценарій. Усі результати одразу потрапляють до історії нижче.">
          <form className="form-grid" onSubmit={runTest}>
            <label className="field">Пристрій
              <select value={deviceId} onChange={event => setDeviceId(event.target.value)} required>
                <option value="">Оберіть пристрій</option>
                {devices.map(device => <option key={device.id}
                                               value={device.id}>{device.id} — {device.model || 'модель не задана'} / {device.hardwareRev || 'ревізія не задана'}</option>)}
              </select>
            </label>
            {scenario !== 'SET_FIRMWARE_VERSION' ? <label className="field">Прошивка{scenario === 'CHECK_UPDATE' ? ' (лише сумісні)' : ''}
              <select value={firmwareId} onChange={event => setFirmwareId(event.target.value)} required={requiresFirmware} disabled={scenario === 'CHECK_UPDATE' && !firmwareOptions.length}>
                <option value="">{scenario === 'CHECK_UPDATE' && !firmwareOptions.length ? 'Немає сумісних прошивок' : 'Оберіть прошивку'}</option>
                {firmwareOptions.map(item => <option key={item.id}
                                              value={item.id}>{item.version} — {item.model} / {item.hardwareRev}</option>)}
              </select>
            </label> : null}
            <label className="field">Сценарій
              <select value={scenario} onChange={event => setScenario(event.target.value as typeof scenario)}>
                {scenarios.map(([value, title]) => <option key={value} value={value}>{title}</option>)}
              </select>
            </label>
            {scenario === 'SET_FIRMWARE_VERSION' && <label className="field">Поточна версія пристрою
              <input
                value={firmwareVersion}
                onChange={event => setFirmwareVersion(event.target.value)}
                placeholder={selectedDevice?.firmwareVersion || 'Напр. 1.0.0'}
                required
              />
            </label>}
            <div className="rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-700">
              {requiresFirmware ? <><strong>Сумісність: </strong>
                {selectedDevice && selectedFirmware
                  ? compatibility(selectedDevice, selectedFirmware) ? 'модель і ревізія збігаються.' : 'модель або ревізія не збігаються.'
                  : 'оберіть пристрій і прошивку.'}</> : scenario === 'CHECK_UPDATE' ? <><strong>Перевірка: </strong>{firmwareOptions.length ? `знайдено сумісних прошивок: ${firmwareOptions.length}; сервер поверне найновішу.` : 'для пристрою немає сумісних прошивок.'}</> : <><strong>Поточна версія: </strong>{selectedDevice?.firmwareVersion || 'не задана'}</>}
              <br/>
              <span className="text-slate-500">{scenarios.find(item => item[0] === scenario)?.[2]}</span>
            </div>
            <button className="button-primary self-end" disabled={running || !deviceId || (requiresFirmware && !firmwareId) || (scenario === 'SET_FIRMWARE_VERSION' && !firmwareVersion.trim())}>
              {running ? 'Виконується…' : 'Запустити сценарій'}
            </button>
          </form>
        </Panel>
      </section>

      <section className="mb-6"><Panel title="Пристрої"><DataTable
        headers={['ID', 'Модель / ревізія', 'Прошивка', 'Статус', 'АКБ', 'Зв’язок', 'Останні помилки']}>
        {devices.map(device => <tr key={device.id}>
          <td className="font-medium">{device.id}</td>
          <td>{device.model || '—'} / {device.hardwareRev || '—'}</td>
          <td>{device.firmwareVersion || '—'}</td>
          <td><Status value={device.status}/></td>
          <td>{device.batteryPercent === null ? '—' : `${device.batteryPercent}%`}</td>
          <td>{date(device.lastSeenAt)}</td>
          <td>{device.errors.length ? device.errors.map(error => <div
            key={error.createdAt}>{error.code}: {error.message}</div>) : '—'}</td>
        </tr>)}
      </DataTable></Panel></section>

      <section className="mb-6"><Panel title="Прошивки"><DataTable
        headers={['Версія', 'Сумісність', 'Опис', 'Файл', 'Розмір', 'Додано']}>
        {firmware.map(item => <tr key={item.id}>
          <td className="font-medium">{item.version}</td>
          <td>{item.model} / {item.hardwareRev}</td>
          <td>{item.changelog}</td>
          <td>{item.filename}</td>
          <td>{item.sizeBytes} Б</td>
          <td>{date(item.createdAt)}</td>
        </tr>)}
      </DataTable></Panel></section>

      <section className="grid gap-6 lg:grid-cols-2">
        <Panel title="Історія оновлень"><DataTable headers={['Пристрій', 'Версія', 'Статус', 'Час', 'Повідомлення']}>
          {events.updates.map(update => <tr key={update.id}>
            <td>{update.device.id}</td>
            <td>{update.firmware.version}</td>
            <td><Status value={update.status}/></td>
            <td>{date(update.offeredAt)}</td>
            <td>{update.errorMessage || '—'}</td>
          </tr>)}
        </DataTable></Panel>
        <Panel title="Історія помилок"><DataTable headers={['Пристрій', 'Код', 'Повідомлення', 'Час']}>
          {events.errors.map(error => <tr key={`${error.deviceId}-${error.createdAt}`}>
            <td>{error.deviceId}</td>
            <td><Status value={error.code}/></td>
            <td>{error.message}</td>
            <td>{date(error.createdAt)}</td>
          </tr>)}
        </DataTable></Panel>
      </section>
    </main>
  );
}

function Panel({title, description, children}: { title: string; description?: string; children: React.ReactNode }) {
  return <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><h2
    className="text-lg font-semibold text-slate-950">{title}</h2>{description &&
    <p className="mb-5 mt-1 text-sm text-slate-600">{description}</p>}
    <div className={description ? '' : 'mt-5'}>{children}</div>
  </section>;
}

function DataTable({headers, children}: { headers: string[]; children: React.ReactNode }) {
  return <div className="overflow-x-auto">
    <table>
      <thead>
      <tr>{headers.map(header => <th key={header}>{header}</th>)}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </div>;
}

function Status({value}: { value: string }) {
  const danger = /ERROR|FAILED|AUTH|DISCONNECTED/.test(value);
  const warning = /OFFERED|CONFIRMED|DOWNLOADING/.test(value);
  return <span
    className={`badge ${danger ? 'badge-danger' : warning ? 'badge-warning' : 'badge-success'}`}>{value}</span>;
}
