import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function configureNativeIOS(plist) {
  const command = (value) => execFileSync('/usr/libexec/PlistBuddy', ['-c', value, plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const read = (key) => { try { return command(`Print :${key}`); } catch { return null; } };
  const description = read('NSLocalNetworkUsageDescription');
  if (!description?.trim()) {
    const action = description === null ? 'Add' : 'Set';
    command(`${action} :NSLocalNetworkUsageDescription ${action === 'Add' ? 'string ' : ''}"Discover and advertise services on your local network."`);
  }
  let services = read('NSBonjourServices');
  if (services === null) { command('Add :NSBonjourServices array'); services = ''; }
  else if (!services.startsWith('Array {')) throw new Error('NSBonjourServices must be an array in the playground Info.plist');
  for (const type of ['_http._tcp', '_airplay._tcp', '_googlecast._tcp']) {
    if (!services.split('\n').some(line => line.trim() === type)) command(`Add :NSBonjourServices: string ${type}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const plist = resolve(dirname(fileURLToPath(import.meta.url)), '../ios/App/App/Info.plist');
  if (process.platform === 'darwin' && existsSync(plist)) configureNativeIOS(plist);
}
