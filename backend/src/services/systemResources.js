// Host-level resource usage (CPU load, memory, disk) for THIS node only.
// Shared by /metrics (Zabbix) and /system/health (admin UI) so both read
// from one place and never drift out of sync with each other.
const os = require('os');
const { execSync } = require('child_process');

function getDiskUsage(mountPath = '/') {
  try {
    // -k for 1K blocks (portable across df implementations), -P for
    // POSIX-stable column layout regardless of locale/terminal width.
    const out = execSync(`df -kP ${mountPath}`, { encoding: 'utf8', timeout: 5000 });
    const fields = out.trim().split('\n').pop().trim().split(/\s+/);
    // Filesystem 1K-blocks Used Available Capacity Mounted-on
    const totalKb = parseInt(fields[1], 10);
    const usedKb  = parseInt(fields[2], 10);
    if (!totalKb) return { disk_total_gb: null, disk_used_pct: null };
    return {
      disk_total_gb: parseFloat((totalKb / 1024 / 1024).toFixed(2)),
      disk_used_pct: parseFloat(((usedKb / totalKb) * 100).toFixed(2)),
    };
  } catch {
    return { disk_total_gb: null, disk_used_pct: null };
  }
}

function getResourceUsage() {
  const loadAvg  = os.loadavg();
  const freemem  = os.freemem();
  const totalmem = os.totalmem();
  const cpuCount = os.cpus().length;
  const disk     = getDiskUsage('/');

  return {
    cpu_count:         cpuCount,
    cpu_load_avg_1m:   parseFloat(loadAvg[0].toFixed(2)),
    cpu_load_avg_5m:   parseFloat(loadAvg[1].toFixed(2)),
    cpu_load_avg_15m:  parseFloat(loadAvg[2].toFixed(2)),
    // Normalized so a fully-loaded box reads ~100% regardless of core
    // count -- a raw load average of 4 means very different things on a
    // 2-core vs 16-core host, this doesn't.
    cpu_load_pct:      parseFloat(((loadAvg[0] / cpuCount) * 100).toFixed(1)),
    mem_total_mb:      Math.round(totalmem / 1024 / 1024),
    mem_used_pct:      parseFloat((((totalmem - freemem) / totalmem) * 100).toFixed(2)),
    disk_total_gb:     disk.disk_total_gb,
    disk_used_pct:     disk.disk_used_pct,
  };
}

module.exports = { getResourceUsage };
