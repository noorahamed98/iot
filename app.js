// Handle sidebar device history loading
async function loadSidebarHistory() {
  const res = await fetch("/history");
  const history = await res.json();
  const sidebar = document.getElementById("sidebarHistory");
  sidebar.innerHTML = "";

  history.reverse().forEach(t => {
    const li = document.createElement("li");
    li.textContent = t.name;
    li.title = "Click to download";
    li.onclick = () => {
      const a = document.createElement("a");
      a.href = `/certs/${t.name}.zip`;
      a.download = `${t.name}.zip`;
      a.click();
    };
    sidebar.appendChild(li);
  });
}

// Load sidebar history when page loads
window.addEventListener("DOMContentLoaded", () => {
  loadSidebarHistory();
});

