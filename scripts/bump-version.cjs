const fs = require('node:fs');
const path = require('node:path');

function chromeVersionParts(version) {
  if (typeof version !== 'string' || !/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/.test(version)) {
    throw new Error('Invalid Chrome version: ' + version);
  }
  const parts = version.split('.').map(Number);
  if (parts.some(part => part > 65535) || parts.every(part => part === 0)) {
    throw new Error('Invalid Chrome version: ' + version);
  }
  return [...parts, 0, 0, 0].slice(0, 4);
}

function checkReleaseVersion(current, version) {
  if (!/^[1-9]\d{3}\.[1-9]\d?\.[1-9]\d?\.[1-9]\d{0,4}$/.test(version)) {
    throw new Error('Use the release format YYYY.M.D.N with no leading zeroes.');
  }
  const previous = chromeVersionParts(current);
  const parts = chromeVersionParts(version);
  const [year, month, day, sequence] = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new Error('Invalid release date: ' + parts.slice(0, 3).join('.'));
  }
  const firstDifference = parts.findIndex((part, index) => part !== previous[index]);
  if (firstDifference === -1 || parts[firstDifference] < previous[firstDifference]) {
    throw new Error('Release version must be greater than ' + current + '.');
  }
  const expectedSequence = firstDifference === 3 ? previous[3] + 1 : 1;
  if (sequence !== expectedSequence) {
    throw new Error('Use ' + [...parts.slice(0, 3), expectedSequence].join('.') + ' for this release.');
  }
}

function writeVersionFiles(root, files) {
  const staging = path.join(root, 'artifacts', '.bump-version');
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  try {
    fs.mkdirSync(staging);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error('Another version update is in progress or left backups at ' + staging, { cause: error });
    }
    throw error;
  }

  const applied = [];
  let keepBackups = false;
  try {
    for (const { name, before, after } of files) {
      fs.writeFileSync(path.join(staging, name + '.before'), before);
      fs.writeFileSync(path.join(staging, name + '.after'), after);
    }
    for (const file of files) {
      const target = path.join(root, file.name);
      if (fs.readFileSync(target, 'utf8') !== file.before) throw new Error(file.name + ' changed during the update.');
      fs.renameSync(path.join(staging, file.name + '.after'), target);
      applied.push(file);
    }
  } catch (error) {
    const restoreFailures = [];
    for (const { name, after } of applied.reverse()) {
      const target = path.join(root, name);
      try {
        if (fs.readFileSync(target, 'utf8') !== after) {
          restoreFailures.push(name);
          continue;
        }
        fs.renameSync(path.join(staging, name + '.before'), target);
      } catch {
        restoreFailures.push(name);
      }
    }
    if (restoreFailures.length) {
      keepBackups = true;
      throw new Error(error.message + ' Backups for ' + restoreFailures.join(', ') + ' are at ' + staging, {
        cause: error
      });
    }
    throw error;
  } finally {
    if (!keepBackups) {
      for (const { name } of files) {
        fs.rmSync(path.join(staging, name + '.before'), { force: true });
        fs.rmSync(path.join(staging, name + '.after'), { force: true });
      }
      fs.rmdirSync(staging);
    }
  }
}

function bumpVersion(root, version) {
  const files = ['package.json', 'package-lock.json', 'CHANGELOG.md', 'manifest.json'].map(name => ({
    name,
    before: fs.readFileSync(path.join(root, name), 'utf8')
  }));
  const [pkg, lock, log, manifest] = files;
  const current = JSON.parse(manifest.before).version;
  checkReleaseVersion(current, version);

  const packageVersion = version.replace(/\.(\d+)$/, '-$1');
  const packageInfo = JSON.parse(pkg.before);
  const lockInfo = JSON.parse(lock.before);
  packageInfo.version = packageVersion;
  lockInfo.version = packageVersion;
  lockInfo.packages[''].version = packageVersion;
  for (const [file, json] of [
    [pkg, packageInfo],
    [lock, lockInfo]
  ]) {
    const newline = file.before.includes('\r\n') ? '\r\n' : '\n';
    file.after = JSON.stringify(json, null, 2).replaceAll('\n', newline) + newline;
  }

  // Preserve the manifest's inline arrays and the changelog's existing notes and headings.
  manifest.after = manifest.before.replace(
    /^([ \t]*"version"[ \t]*:[ \t]*)"[^"\r\n]*"/m,
    '$1' + JSON.stringify(version)
  );
  if (JSON.parse(manifest.after).version !== version) throw new Error('Could not update manifest.json version.');
  const unreleased = /^## 未发布[ \t]*(\r?\n)/m;
  if (!unreleased.test(log.before)) throw new Error('CHANGELOG.md needs a ## 未发布 heading.');
  if (log.before.split(/\r?\n/).some(line => line === '## ' + version || line.startsWith('## ' + version + ' '))) {
    throw new Error('CHANGELOG.md already contains release ' + version + '.');
  }
  log.after = log.before.replace(unreleased, (heading, newline) => heading + newline + '## ' + version + newline);

  writeVersionFiles(root, files);
  return current;
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: npm run version:bump -- YYYY.M.D.N');
    const version = process.argv[2];
    const previous = bumpVersion(path.resolve(__dirname, '..'), version);
    console.log('AI-MEMOS ' + previous + ' → ' + version);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { bumpVersion };
