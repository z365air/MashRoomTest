// MashRoom Test – Popup Script

document.addEventListener('DOMContentLoaded', () => {
  loadStats();

  document.getElementById('openEditor').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') });
    window.close();
  });

  document.getElementById('clearData').addEventListener('click', (e) => {
    e.preventDefault();
    if (confirm('Clear all saved project data?')) {
      chrome.storage.local.clear(() => {
        loadStats();
      });
    }
  });
});

function loadStats() {
  chrome.storage.local.get(null, (data) => {
    const projects = Object.keys(data).filter(k => k.startsWith('project_'));
    const count = projects.length;

    document.getElementById('projectCount').textContent = count || '0';

    // Show last track count from most recent project
    let lastTracks = '—';
    if (count > 0) {
      try {
        const latest = projects
          .map(k => ({ key: k, ...data[k] }))
          .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))[0];
        lastTracks = (latest.tracks || []).length;
      } catch (_) {}
    }
    document.getElementById('lastTracks').textContent = lastTracks;

    // Recent projects list
    if (count > 0) {
      const recentSection = document.getElementById('recentSection');
      const recentList = document.getElementById('recentList');
      recentSection.style.display = 'block';
      recentList.innerHTML = '';

      const sorted = projects
        .map(k => ({ key: k, ...data[k] }))
        .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
        .slice(0, 4);

      sorted.forEach(proj => {
        const li = document.createElement('li');
        li.className = 'recent-item';
        const ago = timeAgo(proj.savedAt);
        li.innerHTML = `
          <div class="recent-item-icon"></div>
          <span class="recent-item-name">${escapeHtml(proj.name || 'Untitled')}</span>
          <span class="recent-item-meta">${ago}</span>
        `;
        li.addEventListener('click', () => {
          chrome.tabs.create({
            url: chrome.runtime.getURL(`editor.html?project=${encodeURIComponent(proj.key)}`)
          });
          window.close();
        });
        recentList.appendChild(li);
      });
    }
  });
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
