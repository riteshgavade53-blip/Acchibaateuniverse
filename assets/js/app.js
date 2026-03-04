// GLOBAL VARIABLES
let thoughts = [];
let deletedThoughts = [];
let customCategories = readLocalJSON('custom_categories', []);
let currentStarIndex = -1;
let selectedCategory = 'personal';
let soundEnabled = true;
let animationsEnabled = true;
let duplicateCheckEnabled = true;
let isOwner = false;
let isLoggedInAsOwner = false;
let editMode = false;

// PERSISTENCE KEYS
const STORAGE_KEYS = {
thoughts: 'ultimate_galaxy_v5',
deletedThoughts: 'deleted_thoughts_v5',
customCategories: 'custom_categories'
};

// SUPABASE
const APP_STATE_ROW_ID = 'main';
let supabaseClient = null;
let supabaseReady = false;
let lastRemoteUpdatedAt = 0;
let cloudSyncIntervalId = null;
let localDirty = false;
let lastSyncedStateSnapshot = '';
let authSubscription = null;

function getStateSnapshot(input = {}) {
const state = {
thoughts: Array.isArray(input.thoughts) ? input.thoughts : thoughts,
deletedThoughts: Array.isArray(input.deletedThoughts) ? input.deletedThoughts : deletedThoughts,
customCategories: Array.isArray(input.customCategories) ? input.customCategories : customCategories
};
return JSON.stringify(state);
}

function normalizeEmail(value) {
return String(value || '').trim().toLowerCase();
}

function getAllowedAdminEmails() {
const config = window.SUPABASE_CONFIG || {};
if (!Array.isArray(config.adminEmails)) return [];
return config.adminEmails.map(normalizeEmail).filter(Boolean);
}

function isAdminUser(user) {
const email = normalizeEmail(user && user.email);
if (!email) return false;
const allowed = getAllowedAdminEmails();
if (allowed.length === 0) return true;
return allowed.includes(email);
}

function resetOwnerFlags() {
isOwner = false;
isLoggedInAsOwner = false;
sessionStorage.setItem('isOwner', 'false');
sessionStorage.setItem('isLoggedInAsOwner', 'false');
}

async function getCurrentAuthUser() {
if (!supabaseReady || !supabaseClient || !supabaseClient.auth) {
return null;
}
const { data, error } = await supabaseClient.auth.getUser();
if (error) {
console.error('Supabase auth getUser failed:', error);
return null;
}
return data && data.user ? data.user : null;
}

function applyOwnerSessionToUI() {
const preferredOwnerView = sessionStorage.getItem('isOwner') === 'true';
if (isLoggedInAsOwner) {
isOwner = preferredOwnerView || !sessionStorage.getItem('isOwner');
document.getElementById('loginScreen').style.display = 'none';
if (isOwner) {
setupOwnerMode();
} else {
setupVisitorMode();
document.getElementById('ownerLoginPrompt').style.display = 'block';
}
return;
}

document.getElementById('loginScreen').style.display = 'flex';
setupVisitorMode();
document.getElementById('ownerLogin').style.display = 'none';
document.getElementById('ownerLogoutBtn').style.display = 'none';
document.getElementById('timelineBtn').style.display = 'none';
}

async function restoreOwnerAuthSession() {
if (!supabaseReady || !supabaseClient || !supabaseClient.auth) {
resetOwnerFlags();
applyOwnerSessionToUI();
return;
}

const user = await getCurrentAuthUser();
if (user && isAdminUser(user)) {
isLoggedInAsOwner = true;
sessionStorage.setItem('isLoggedInAsOwner', 'true');
} else {
if (user && !isAdminUser(user)) {
await supabaseClient.auth.signOut();
showToast('This account is not allowed for admin mode.', 'error');
}
resetOwnerFlags();
}
applyOwnerSessionToUI();
}

function clamp(value, min, max) {
return Math.min(max, Math.max(min, value));
}

function getViewportWidth() {
return Math.max(window.innerWidth || 0, 320);
}

function getViewportHeight() {
return Math.max(window.innerHeight || 0, 480);
}

function normalizeStarCoordinates(star) {
if (!star || typeof star !== 'object') return false;

const viewportWidth = Number(star.viewportWidth) > 0 ? Number(star.viewportWidth) : 1366;
const viewportHeight = Number(star.viewportHeight) > 0 ? Number(star.viewportHeight) : 768;

const x = Number(star.x);
const y = Number(star.y);
const hasValidX = Number.isFinite(x);
const hasValidY = Number.isFinite(y);

const defaultXRatio = 0.5;
const defaultYRatio = 0.5;

const computedXRatio = hasValidX ? clamp(x / viewportWidth, 0.03, 0.97) : defaultXRatio;
const computedYRatio = hasValidY ? clamp(y / viewportHeight, 0.08, 0.92) : defaultYRatio;

const currentXRatio = Number(star.xRatio);
const currentYRatio = Number(star.yRatio);
const normalizedXRatio = Number.isFinite(currentXRatio) ? clamp(currentXRatio, 0.03, 0.97) : computedXRatio;
const normalizedYRatio = Number.isFinite(currentYRatio) ? clamp(currentYRatio, 0.08, 0.92) : computedYRatio;

const vw = getViewportWidth();
const vh = getViewportHeight();
const newX = Math.round(normalizedXRatio * vw);
const newY = Math.round(normalizedYRatio * vh);

const changed =
star.xRatio !== normalizedXRatio ||
star.yRatio !== normalizedYRatio ||
star.x !== newX ||
star.y !== newY ||
star.viewportWidth !== vw ||
star.viewportHeight !== vh;

star.xRatio = normalizedXRatio;
star.yRatio = normalizedYRatio;
star.x = newX;
star.y = newY;
star.viewportWidth = vw;
star.viewportHeight = vh;

return changed;
}

function normalizeAllThoughtCoordinates() {
let changed = false;
thoughts.forEach((star) => {
if (normalizeStarCoordinates(star)) {
changed = true;
}
});
return changed;
}

function getStarRenderPosition(star) {
if (!star || typeof star !== 'object') {
return { x: 0, y: 0 };
}

const vw = getViewportWidth();
const vh = getViewportHeight();

const ratioX = Number(star.xRatio);
const ratioY = Number(star.yRatio);

if (Number.isFinite(ratioX) && Number.isFinite(ratioY)) {
return {
x: Math.round(clamp(ratioX, 0.03, 0.97) * vw),
y: Math.round(clamp(ratioY, 0.08, 0.92) * vh)
};
}

const fallbackX = Number(star.x);
const fallbackY = Number(star.y);

return {
x: Number.isFinite(fallbackX) ? clamp(Math.round(fallbackX), 0, vw) : Math.round(vw * 0.5),
y: Number.isFinite(fallbackY) ? clamp(Math.round(fallbackY), 0, vh) : Math.round(vh * 0.5)
};
}

function readLocalJSON(key, fallbackValue) {
try {
const rawValue = localStorage.getItem(key);
return rawValue ? JSON.parse(rawValue) : fallbackValue;
} catch (error) {
console.error(`Failed to parse local storage key: ${key}`, error);
return fallbackValue;
}
}

function syncLocalCache() {
localStorage.setItem(STORAGE_KEYS.thoughts, JSON.stringify(thoughts));
localStorage.setItem(STORAGE_KEYS.deletedThoughts, JSON.stringify(deletedThoughts));
localStorage.setItem(STORAGE_KEYS.customCategories, JSON.stringify(customCategories));
}

function saveThoughts() {
syncLocalCache();
localDirty = true;
void syncDataToSupabase({ showErrorToast: true });
}

function saveDeletedThoughts() {
syncLocalCache();
localDirty = true;
void syncDataToSupabase({ showErrorToast: true });
}

function saveCustomCategories() {
syncLocalCache();
localDirty = true;
void syncDataToSupabase({ showErrorToast: true });
}

function initSupabaseClient() {
try {
const config = window.SUPABASE_CONFIG || {};
if (!config.url || !config.anonKey) {
console.warn('Supabase config missing. Running in local-only mode.');
return;
}
if (Array.isArray(config.allowedHosts) && config.allowedHosts.length > 0) {
const currentHost = window.location && window.location.host ? window.location.host.toLowerCase() : '';
const allowed = config.allowedHosts.map((host) => String(host || '').trim().toLowerCase()).filter(Boolean);
if (!allowed.includes(currentHost)) {
console.warn('Supabase disabled for this host:', currentHost);
return;
}
}
if (!window.supabase || typeof window.supabase.createClient !== 'function') {
console.warn('Supabase library not loaded. Running in local-only mode.');
return;
}

supabaseClient = window.supabase.createClient(config.url, config.anonKey);
supabaseReady = true;

if (supabaseClient.auth && typeof supabaseClient.auth.onAuthStateChange === 'function') {
const { data } = supabaseClient.auth.onAuthStateChange((event, session) => {
if (event === 'SIGNED_OUT') {
resetOwnerFlags();
applyOwnerSessionToUI();
}
if (event === 'SIGNED_IN' && session && session.user && isAdminUser(session.user)) {
isLoggedInAsOwner = true;
sessionStorage.setItem('isLoggedInAsOwner', 'true');
applyOwnerSessionToUI();
}
});
authSubscription = data && data.subscription ? data.subscription : null;
}
} catch (error) {
console.error('Supabase init failed:', error);
supabaseReady = false;
}
}

async function loadDataFromStorageAndSupabase() {
thoughts = readLocalJSON(STORAGE_KEYS.thoughts, []);
deletedThoughts = readLocalJSON(STORAGE_KEYS.deletedThoughts, []);
customCategories = readLocalJSON(STORAGE_KEYS.customCategories, []);
const normalizedLocal = normalizeAllThoughtCoordinates();
if (normalizedLocal) {
syncLocalCache();
}

if (!supabaseReady) {
return;
}

try {
const { data, error } = await supabaseClient
.from('app_state')
.select('thoughts, deleted_thoughts, custom_categories, updated_at')
.eq('id', APP_STATE_ROW_ID)
.maybeSingle();

if (error) {
console.error('Supabase read failed:', error);
showToast('Cloud read failed. Check network or Supabase policies.', 'warning');
return;
}

if (data) {
thoughts = Array.isArray(data.thoughts) ? data.thoughts : [];
deletedThoughts = Array.isArray(data.deleted_thoughts) ? data.deleted_thoughts : [];
customCategories = Array.isArray(data.custom_categories) ? data.custom_categories : [];
lastRemoteUpdatedAt = Date.parse(data.updated_at || '') || Date.now();
const didNormalize = normalizeAllThoughtCoordinates();
syncLocalCache();
localDirty = false;
lastSyncedStateSnapshot = getStateSnapshot();
if (didNormalize) {
void syncDataToSupabase({ showErrorToast: false });
}
} else {
await syncDataToSupabase({ showErrorToast: true });
}
} catch (error) {
console.error('Supabase load error:', error);
showToast('Cloud sync unavailable right now.', 'warning');
}
}

async function syncDataToSupabase(options = {}) {
const { showErrorToast = false } = options;
if (!supabaseReady) {
return false;
}

const nowIso = new Date().toISOString();
const currentStateSnapshot = getStateSnapshot();
if (currentStateSnapshot !== lastSyncedStateSnapshot) {
localDirty = true;
}
const payload = {
id: APP_STATE_ROW_ID,
thoughts,
deleted_thoughts: deletedThoughts,
custom_categories: customCategories,
updated_at: nowIso
};

try {
const { error } = await supabaseClient
.from('app_state')
.upsert(payload, { onConflict: 'id' });

if (error) {
console.error('Supabase sync failed:', error);
if (showErrorToast) {
showToast('Cloud save failed. Data is only on this device.', 'warning');
}
return false;
}
lastRemoteUpdatedAt = Date.parse(nowIso) || Date.now();
localDirty = false;
lastSyncedStateSnapshot = currentStateSnapshot;
return true;
} catch (error) {
console.error('Supabase sync error:', error);
if (showErrorToast) {
showToast('Cloud save failed. Data is only on this device.', 'warning');
}
return false;
}
}

async function refreshDataFromSupabase(silent = true) {
if (!supabaseReady) return false;

try {
const { data, error } = await supabaseClient
.from('app_state')
.select('thoughts, deleted_thoughts, custom_categories, updated_at')
.eq('id', APP_STATE_ROW_ID)
.maybeSingle();

if (error || !data) {
if (error) {
console.error('Supabase refresh failed:', error);
}
return false;
}

const remoteUpdatedAt = Date.parse(data.updated_at || '') || 0;
const remoteThoughts = Array.isArray(data.thoughts) ? data.thoughts : [];
const remoteDeletedThoughts = Array.isArray(data.deleted_thoughts) ? data.deleted_thoughts : [];
const remoteCustomCategories = Array.isArray(data.custom_categories) ? data.custom_categories : [];
const remoteSnapshot = getStateSnapshot({
thoughts: remoteThoughts,
deletedThoughts: remoteDeletedThoughts,
customCategories: remoteCustomCategories
});
const localSnapshot = getStateSnapshot();
const hasRemoteStateChanged = remoteSnapshot !== localSnapshot;
const shouldApply =
remoteUpdatedAt > lastRemoteUpdatedAt ||
thoughts.length === 0 ||
(!localDirty && hasRemoteStateChanged);

if (!shouldApply) {
return false;
}

thoughts = remoteThoughts;
deletedThoughts = remoteDeletedThoughts;
customCategories = remoteCustomCategories;
lastRemoteUpdatedAt = remoteUpdatedAt || Date.now();
localDirty = false;
lastSyncedStateSnapshot = remoteSnapshot;

normalizeAllThoughtCoordinates();
syncLocalCache();
renderStars();
loadCustomCategories();
updateRecycleBinCount();
updateTimelineIfOpen();

if (!silent) {
showToast('Latest thoughts synced from cloud.', 'success');
}
return true;
} catch (error) {
console.error('Supabase refresh error:', error);
return false;
}
}

function startCloudSyncPolling() {
if (!supabaseReady || cloudSyncIntervalId) {
return;
}

const runCloudSyncCycle = async (silent = true) => {
if (localDirty) {
const pushed = await syncDataToSupabase({ showErrorToast: !silent });
if (!pushed && !silent) {
showToast('Cloud save pending. Will retry automatically.', 'warning');
return false;
}
}

return refreshDataFromSupabase(silent);
};

cloudSyncIntervalId = setInterval(() => {
void runCloudSyncCycle(true);
}, 10000);

window.addEventListener('visibilitychange', () => {
if (document.visibilityState === 'visible') {
void runCloudSyncCycle(true);
}
});

window.addEventListener('online', () => {
void runCloudSyncCycle(false);
});

void runCloudSyncCycle(true);
}

// ZOOM VARIABLES
let currentZoom = 1;
const minZoom = 0.3;
const maxZoom = 3;
const zoomStep = 0.2;
let isDragging = false;
let startX, startY;
let translateX = 0, translateY = 0;

// INITIALIZE
async function initApp() {
// Create background stars
createBackgroundStars();

// Create asteroid belt
createAsteroidBelt();

// Create galaxy map
createGalaxyMap();

// Initialize Supabase and fetch latest state
initSupabaseClient();
await loadDataFromStorageAndSupabase();
startCloudSyncPolling();

// Load custom categories
loadCustomCategories();

await restoreOwnerAuthSession();

renderStars();
createShootingStars();
updateRecycleBinCount();

// Add click outside event for modal
window.addEventListener('click', function(event) {
const modal = document.getElementById('starModal');
if (event.target === modal) {
closeStarModal();
}

const recycleModal = document.getElementById('recycleBinModal');
if (event.target === recycleModal) {
closeRecycleBin();
}

const timelineModal = document.getElementById('timelineModal');
if (event.target === timelineModal) {
closeTimeline();
}

const searchBar = document.getElementById('searchBar');
if (searchBar && !searchBar.contains(event.target)) {
hideSearchSuggestions();
}
});

// Add mouse wheel event for zooming
document.getElementById('universe-container').addEventListener('wheel', handleWheel, { passive: false });

// Add drag functionality for panning
const universeContainer = document.getElementById('universe-container');
universeContainer.addEventListener('mousedown', startDrag);
universeContainer.addEventListener('mousemove', drag);
universeContainer.addEventListener('mouseup', endDrag);
universeContainer.addEventListener('mouseleave', endDrag);

// Touch events for mobile
universeContainer.addEventListener('touchstart', handleTouchStart, { passive: false });
universeContainer.addEventListener('touchmove', handleTouchMove, { passive: false });
universeContainer.addEventListener('touchend', endDrag);

window.addEventListener('resize', () => {
const changed = normalizeAllThoughtCoordinates();
renderStars();
if (changed) {
saveThoughts();
}
});
}

// CUSTOM CATEGORIES FUNCTIONS
function loadCustomCategories() {
// Add custom categories to the editor
const editorCategories = document.getElementById('editorCategories');

// Clear existing elements
while (editorCategories.firstChild) {
editorCategories.removeChild(editorCategories.firstChild);
}

// Add default categories
const defaultCategories = ['personal', 'work', 'ideas'];
defaultCategories.forEach(category => {
const categoryPill = document.createElement('div');
categoryPill.className = 'category-pill';
categoryPill.textContent = category.charAt(0).toUpperCase() + category.slice(1);
categoryPill.onclick = function() { selectCategory(this, category); };
editorCategories.appendChild(categoryPill);
});

// Add custom categories
customCategories.forEach(category => {
const categoryPill = document.createElement('div');
categoryPill.className = 'category-pill custom';
categoryPill.textContent = category;
categoryPill.onclick = function() { selectCategory(this, category); };
editorCategories.appendChild(categoryPill);
});

// Add input field and plus button
const inputField = document.createElement('input');
inputField.type = 'text';
inputField.className = 'new-category-input';
inputField.id = 'newCategoryInput';
inputField.placeholder = 'New category';
inputField.onkeypress = handleNewCategoryKeypress;
inputField.style.display = 'none';

const plusBtn = document.createElement('button');
plusBtn.className = 'plus-category-btn';
plusBtn.id = 'plusCategoryBtn';
plusBtn.innerHTML = '<i class="fas fa-plus"></i> Add';
plusBtn.onclick = showAddCategoryInput;

editorCategories.appendChild(inputField);
editorCategories.appendChild(plusBtn);

// Also update filter categories in log modal (without Add button)
updateFilterCategories();

// Update tag options in modal
updateTagOptions();
}

function updateFilterCategories() {
const filterCategories = document.getElementById('filterCategories');
if (!filterCategories) return;

// Clear existing elements
while (filterCategories.firstChild) {
filterCategories.removeChild(filterCategories.firstChild);
}

// Add "All" option
const allPill = document.createElement('div');
allPill.className = 'category-pill active';
allPill.textContent = 'All';
allPill.onclick = function() { filterByCategory('all'); };
filterCategories.appendChild(allPill);

// Add default categories
const defaultCategories = ['personal', 'work', 'ideas'];
defaultCategories.forEach(category => {
const categoryPill = document.createElement('div');
categoryPill.className = 'category-pill';
categoryPill.textContent = category.charAt(0).toUpperCase() + category.slice(1);
categoryPill.onclick = function() { filterByCategory(category); };
filterCategories.appendChild(categoryPill);
});

// Add custom categories
customCategories.forEach(category => {
const categoryPill = document.createElement('div');
categoryPill.className = 'category-pill custom-category';
categoryPill.textContent = category;
categoryPill.onclick = function() { filterByCategory(category); };
filterCategories.appendChild(categoryPill);
});
}

function updateTagOptions() {
const tagSelect = document.getElementById('tagSelect');
if (!tagSelect) return;

// Clear existing options
while (tagSelect.children.length > 0) {
tagSelect.removeChild(tagSelect.firstChild);
}

// Add default categories
const defaultOptions = ['personal', 'work', 'ideas'];
defaultOptions.forEach(option => {
const optionElement = document.createElement('option');
optionElement.value = option;
optionElement.textContent = option.charAt(0).toUpperCase() + option.slice(1);
tagSelect.appendChild(optionElement);
});

// Add custom categories
customCategories.forEach(category => {
const optionElement = document.createElement('option');
optionElement.value = category;
optionElement.textContent = category;
tagSelect.appendChild(optionElement);
});
}

function showAddCategoryInput() {
const inputField = document.getElementById('newCategoryInput');
const plusBtn = document.getElementById('plusCategoryBtn');

inputField.style.display = 'block';
plusBtn.style.display = 'none';
inputField.focus();
}

function normalizeCategoryName(rawName) {
return (rawName || '').replace(/\s+/g, ' ').trim();
}

function hasCategory(categoryName) {
const normalized = normalizeCategoryName(categoryName).toLowerCase();
if (!normalized) return false;

const defaultCategories = ['personal', 'work', 'ideas'];
if (defaultCategories.includes(normalized)) {
return true;
}

return customCategories.some((category) => category.toLowerCase() === normalized);
}

function addCategoryAndRefresh(categoryName, options = {}) {
const normalized = normalizeCategoryName(categoryName);
const { selectInEditor = false, selectInTag = false } = options;

if (!normalized) {
showToast('Please enter a category name', 'warning');
return false;
}

if (hasCategory(normalized)) {
showToast('This category already exists', 'warning');
return false;
}

customCategories.push(normalized);
saveCustomCategories();
loadCustomCategories();

if (selectInEditor) {
const categoryPills = document.querySelectorAll('#editorCategories .category-pill');
categoryPills.forEach((pill) => {
if (pill.textContent === normalized) {
selectCategory(pill, normalized);
}
});
}

if (selectInTag) {
const tagSelect = document.getElementById('tagSelect');
if (tagSelect) {
tagSelect.value = normalized;
}
}

showToast(`Category "${normalized}" added successfully`, 'success');
return true;
}

function handleNewCategoryKeypress(event) {
if (event.key === 'Enter') {
addCustomCategory();
} else if (event.key === 'Escape') {
hideAddCategoryInput();
}
}

function addCustomCategory() {
const inputField = document.getElementById('newCategoryInput');
const categoryName = inputField.value;
const added = addCategoryAndRefresh(categoryName, { selectInEditor: true, selectInTag: true });
if (added) {
hideAddCategoryInput();
}
}

function hideAddCategoryInput() {
const inputField = document.getElementById('newCategoryInput');
const plusBtn = document.getElementById('plusCategoryBtn');

inputField.style.display = 'none';
plusBtn.style.display = 'flex';
inputField.value = '';
}

// Add tag from modal
function addTagFromModal() {
const tagInput = document.getElementById('tagNewInput');
const tagName = tagInput.value;
const added = addCategoryAndRefresh(tagName, { selectInTag: true });
if (added) {
tagInput.value = '';
}
}

// ZOOM FUNCTIONS - ENHANCED
function handleWheel(e) {
e.preventDefault();

const delta = e.deltaY > 0 ? -zoomStep : zoomStep;
const newZoom = Math.max(minZoom, Math.min(maxZoom, currentZoom + delta));

// Calculate the position relative to the center of the screen
const rect = e.currentTarget.getBoundingClientRect();
const x = e.clientX - rect.left;
const y = e.clientY - rect.top;

// Adjust the translation to zoom toward the mouse position
const scale = newZoom / currentZoom;
translateX = x - (x - translateX) * scale;
translateY = y - (y - translateY) * scale;

currentZoom = newZoom;
updateZoom();
document.getElementById('zoomSlider').value = Math.round(currentZoom * 100);

// Show/hide galaxy map based on zoom level
if (currentZoom <= 0.5) {
document.getElementById('galaxyMap').classList.add('visible');
} else {
document.getElementById('galaxyMap').classList.remove('visible');
}
}

function setZoom(value) {
currentZoom = value / 100;
updateZoom();

// Show/hide galaxy map based on zoom level
if (currentZoom <= 0.5) {
document.getElementById('galaxyMap').classList.add('visible');
} else {
document.getElementById('galaxyMap').classList.remove('visible');
}
}

function zoomIn() {
currentZoom = Math.min(maxZoom, currentZoom + zoomStep);
updateZoom();
document.getElementById('zoomSlider').value = Math.round(currentZoom * 100);
}

function zoomOut() {
currentZoom = Math.max(minZoom, currentZoom - zoomStep);
updateZoom();
document.getElementById('zoomSlider').value = Math.round(currentZoom * 100);

// Show galaxy map when zoomed out enough
if (currentZoom <= 0.5) {
document.getElementById('galaxyMap').classList.add('visible');
}
}

function resetZoom() {
currentZoom = 1;
translateX = 0;
translateY = 0;
updateZoom();
document.getElementById('zoomSlider').value = 100;
document.getElementById('galaxyMap').classList.remove('visible');
}

function updateZoom() {
const universeContainer = document.getElementById('universe-container');
universeContainer.style.transform = `translate(${translateX}px, ${translateY}px) scale(${currentZoom})`;
document.getElementById('zoomLevel').textContent = Math.round(currentZoom * 100) + '%';
}

function isInteractiveTarget(target) {
if (!target || typeof target.closest !== 'function') return false;

return Boolean(
target.closest('.star-point') ||
target.closest('.planet') ||
target.closest('.astronaut') ||
target.closest('.modal') ||
target.closest('.shiva-container') ||
target.closest('.zoom-controls') ||
target.closest('.fab-container') ||
target.closest('#recycleBinBtn') ||
target.closest('#searchBar') ||
target.closest('#timelineBtn') ||
target.closest('#writingPanel') ||
target.closest('#modeSwitcher') ||
target.closest('#ownerLogoutBtn') ||
target.closest('#visitorInfo') ||
target.closest('#ownerLoginPrompt')
);
}

// DRAG FUNCTIONS
function startDrag(e) {
// Check if clicking on interactive elements
if (isInteractiveTarget(e.target)) {
return;
}

isDragging = true;
startX = e.clientX - translateX;
startY = e.clientY - translateY;
document.getElementById('universe-container').classList.add('dragging');
}

function drag(e) {
if (!isDragging) return;

translateX = e.clientX - startX;
translateY = e.clientY - startY;
updateZoom();
}

function endDrag() {
isDragging = false;
document.getElementById('universe-container').classList.remove('dragging');
}

// Touch event handlers for mobile
let touchStartDistance = 0;
let touchStartZoom = 1;

function handleTouchStart(e) {
if (isInteractiveTarget(e.target)) {
isDragging = false;
return;
}

if (e.touches.length === 1) {
// Single touch for dragging
const touch = e.touches[0];
startX = touch.clientX - translateX;
startY = touch.clientY - translateY;
isDragging = true;
} else if (e.touches.length === 2) {
// Two touches for pinching to zoom
isDragging = false;
const dx = e.touches[0].clientX - e.touches[1].clientX;
const dy = e.touches[0].clientY - e.touches[1].clientY;
touchStartDistance = Math.sqrt(dx * dx + dy * dy);
touchStartZoom = currentZoom;
}
}

function handleTouchMove(e) {
if (e.touches.length === 1 && isDragging) {
e.preventDefault();
// Single touch for dragging
const touch = e.touches[0];
translateX = touch.clientX - startX;
translateY = touch.clientY - startY;
updateZoom();
} else if (e.touches.length === 2) {
e.preventDefault();
// Two touches for pinching to zoom
const dx = e.touches[0].clientX - e.touches[1].clientX;
const dy = e.touches[0].clientY - e.touches[1].clientY;
const distance = Math.sqrt(dx * dx + dy * dy);

const scale = distance / touchStartDistance;
currentZoom = Math.max(minZoom, Math.min(maxZoom, touchStartZoom * scale));
updateZoom();
document.getElementById('zoomSlider').value = Math.round(currentZoom * 100);

// Show/hide galaxy map based on zoom level
if (currentZoom <= 0.5) {
document.getElementById('galaxyMap').classList.add('visible');
} else {
document.getElementById('galaxyMap').classList.remove('visible');
}
}
}

// CREATE GALAXY MAP
function createGalaxyMap() {
const galaxyMap = document.getElementById('galaxyMap');
const galaxyData = [
{ name: 'Andromeda', x: 20, y: 30, size: 150, color: 'rgba(255, 100, 200, 0.3)' },
{ name: 'Milky Way', x: 50, y: 50, size: 200, color: 'rgba(100, 200, 255, 0.3)' },
{ name: 'Triangulum', x: 70, y: 20, size: 120, color: 'rgba(200, 255, 100, 0.3)' },
{ name: 'Centaurus A', x: 30, y: 70, size: 140, color: 'rgba(255, 200, 100, 0.3)' },
{ name: 'Whirlpool', x: 80, y: 60, size: 130, color: 'rgba(100, 255, 200, 0.3)' }
];

galaxyData.forEach(galaxy => {
const galaxyElement = document.createElement('div');
galaxyElement.className = 'galaxy-cluster';
galaxyElement.style.left = `${galaxy.x}%`;
galaxyElement.style.top = `${galaxy.y}%`;
galaxyElement.style.width = `${galaxy.size}px`;
galaxyElement.style.height = `${galaxy.size}px`;
galaxyElement.style.background = `radial-gradient(circle, ${galaxy.color} 0%, transparent 70%)`;

const galaxyName = document.createElement('div');
galaxyName.className = 'galaxy-name';
galaxyName.textContent = galaxy.name;
galaxyElement.appendChild(galaxyName);

galaxyElement.addEventListener('click', () => {
showToast(`Navigating to ${galaxy.name} galaxy...`, 'info');
// Simulate navigation to the selected galaxy
setTimeout(() => {
resetZoom();
document.getElementById('galaxyMap').classList.remove('visible');
}, 1000);
});

galaxyMap.appendChild(galaxyElement);
});
}

// CREATE BACKGROUND STARS
function createBackgroundStars() {
const starsLayer = document.getElementById('starsLayer');
const starCount = 200;

for (let i = 0; i < starCount; i++) {
const star = document.createElement('div');
star.className = 'star';

// Random position
const x = Math.random() * 100;
const y = Math.random() * 100;

// Random size
const size = Math.random() * 2 + 0.5;

// Random animation delay
const delay = Math.random() * 4;

star.style.left = `${x}%`;
star.style.top = `${y}%`;
star.style.width = `${size}px`;
star.style.height = `${size}px`;
star.style.animationDelay = `${delay}s`;

starsLayer.appendChild(star);
}
}

// CREATE ASTEROID BELT
function createAsteroidBelt() {
const asteroidBelt = document.getElementById('asteroidBelt');
const asteroidCount = 50;

for (let i = 0; i < asteroidCount; i++) {
const asteroid = document.createElement('div');
asteroid.className = 'asteroid';

// Random position in the belt
const angle = Math.random() * 360;
const distance = 280 + Math.random() * 40; // Belt width
const x = 50 + distance * Math.cos(angle * Math.PI / 180) / 3;
const y = 50 + distance * Math.sin(angle * Math.PI / 180) / 3;

// Random size
const size = Math.random() * 3 + 1;

asteroid.style.left = `${x}%`;
asteroid.style.top = `${y}%`;
asteroid.style.width = `${size}px`;
asteroid.style.height = `${size}px`;

asteroidBelt.appendChild(asteroid);
}
}

// LOGIN FUNCTIONS
function loginAsOwner() {
document.getElementById('ownerLogin').style.display = 'block';
}

function loginAsVisitor() {
document.getElementById('loginScreen').style.display = 'none';
setupVisitorMode();
showToast('Welcome, Explorer! \u{1F30C}', 'info');
}

async function unlock() {
if (!supabaseReady || !supabaseClient || !supabaseClient.auth) {
showToast('Supabase auth not ready. Check config.', 'error');
return;
}

const emailInput = document.getElementById('ownerEmailInput');
const passInput = document.getElementById('ownerPasswordInput');
const email = normalizeEmail(emailInput && emailInput.value);
const password = passInput ? passInput.value : '';

if (!email || !password) {
showToast('Enter admin email and password.', 'warning');
if (emailInput && !email) shakeElement(emailInput);
if (passInput && !password) shakeElement(passInput);
return;
}

const { data, error } = await supabaseClient.auth.signInWithPassword({
email,
password
});

if (error || !data || !data.user) {
const detail = error && (error.message || error.details || error.code) ? ` (${error.message || error.details || error.code})` : '';
showToast(`Admin login failed. Check email/password.${detail}`, 'error');
if (passInput) shakeElement(passInput);
return;
}

if (!isAdminUser(data.user)) {
await supabaseClient.auth.signOut();
showToast('This account is not allowed for admin mode.', 'error');
return;
}

isOwner = true;
isLoggedInAsOwner = true;
sessionStorage.setItem('isOwner', 'true');
sessionStorage.setItem('isLoggedInAsOwner', 'true');
document.getElementById('loginScreen').style.display = 'none';
setupOwnerMode();
showToast('Secure admin login successful.', 'success');
}

async function ownerLogout() {
const emailInput = document.getElementById('ownerEmailInput');
const passInput = document.getElementById('ownerPasswordInput');
if (emailInput) emailInput.value = '';
if (passInput) passInput.value = '';
document.getElementById('ownerLogin').style.display = 'none';

if (supabaseReady && supabaseClient && supabaseClient.auth) {
const { error } = await supabaseClient.auth.signOut();
if (error) {
console.error('Supabase signOut failed:', error);
showToast('Logout failed. Try again.', 'error');
return;
}
}

resetOwnerFlags();
applyOwnerSessionToUI();
showToast('Logged out from owner mode.', 'info');
}

// MODE SWITCHING FUNCTIONS
function switchMode() {
if (isLoggedInAsOwner) {
if (isOwner) {
// Switch to visitor mode
isOwner = false;
sessionStorage.setItem('isOwner', 'false');
setupVisitorMode();
showToast('Switched to Visitor Mode \u{1F441}\u{FE0F}', 'info');
} else {
// Switch to owner mode
switchToOwner();
}
}
}

function switchToOwner() {
if (isLoggedInAsOwner) {
isOwner = true;
sessionStorage.setItem('isOwner', 'true');
setupOwnerMode();
showToast('Switched to Owner Mode \u{1F451}', 'success');
}
}

// MODE SETUP
function setupOwnerMode() {
// Show owner-only elements
document.getElementById('ownerBadge').style.display = 'block';
document.getElementById('writingPanel').style.display = 'block';
document.querySelector('.fab-container').style.display = 'block';
document.getElementById('modeSwitcher').style.display = 'flex';
document.getElementById('ownerLogoutBtn').style.display = 'flex';
document.getElementById('modeSwitchText').textContent = 'Switch to Visitor';
document.getElementById('recycleBinBtn').style.display = 'flex';
document.getElementById('timelineBtn').style.display = 'flex';

// Hide visitor-only elements
document.getElementById('visitorInfo').style.display = 'none';
document.getElementById('ownerLoginPrompt').style.display = 'none';

// Enable editing features
updateStarModalForOwner();
updateRecycleBinCount();

// Load custom categories
loadCustomCategories();
}

function setupVisitorMode() {
// Hide owner-only elements
document.getElementById('ownerBadge').style.display = 'none';
document.getElementById('writingPanel').style.display = 'none';
document.querySelector('.fab-container').style.display = 'none';
document.getElementById('recycleBinBtn').style.display = 'none';
document.getElementById('timelineBtn').style.display = 'flex';

// Show visitor-only elements
document.getElementById('visitorInfo').style.display = 'block';

// Update mode switcher if logged in as owner
if (isLoggedInAsOwner) {
document.getElementById('modeSwitcher').style.display = 'flex';
document.getElementById('ownerLogoutBtn').style.display = 'flex';
document.getElementById('modeSwitchText').textContent = 'Switch to Owner';
document.getElementById('ownerLoginPrompt').style.display = 'block';
} else {
document.getElementById('modeSwitcher').style.display = 'none';
document.getElementById('ownerLogoutBtn').style.display = 'none';
document.getElementById('ownerLoginPrompt').style.display = 'none';
}

// Disable editing features
updateStarModalForVisitor();
}

function updateStarModalForOwner() {
const actionsDiv = document.getElementById('starActions');
actionsDiv.innerHTML = `
<button class="btn-secondary" id="editThoughtBtn" onclick="enableThoughtEdit()"><i class="fas fa-edit"></i> Edit</button>
<button class="btn-danger" onclick="moveToRecycleBin()"><i class="fas fa-trash"></i> Delete</button>
<button class="btn-main" onclick="closeStarModal()">Close</button>
`;
}

function updateStarModalForVisitor() {
const actionsDiv = document.getElementById('starActions');
actionsDiv.innerHTML = `
<button class="btn-main" onclick="closeStarModal()">Close</button>
`;
}

// UI FUNCTIONS
function togglePanel() {
if (!isOwner) return;
document.getElementById('writingPanel').classList.toggle('minimized');
}

function toggleSettings() {
if (!isOwner) return;
document.getElementById('settingsPanel').classList.toggle('show');
}

function toggleStats() {
if (!isOwner) return;
document.getElementById('statsPanel').classList.toggle('show');
updateStats();
}

function toggleTheme() {
document.body.classList.toggle('light-theme');
const isLight = document.body.classList.contains('light-theme');
localStorage.setItem('theme', isLight ? 'light' : 'dark');
showToast(`Theme changed to ${isLight ? 'Light' : 'Dark'} mode`, 'info');
}

function toggleSound() {
soundEnabled = document.getElementById('soundToggle').checked;
localStorage.setItem('soundEnabled', soundEnabled);
showToast(`Sound effects ${soundEnabled ? 'enabled' : 'disabled'}`, 'info');
}

function toggleAnimations() {
animationsEnabled = document.getElementById('animationToggle').checked;
localStorage.setItem('animationsEnabled', animationsEnabled);
if (!animationsEnabled) {
document.querySelectorAll('*').forEach(el => {
el.style.animation = 'none';
el.style.transition = 'none';
});
} else {
location.reload();
}
}

function toggleDuplicateCheck() {
duplicateCheckEnabled = document.getElementById('duplicateCheck').checked;
localStorage.setItem('duplicateCheckEnabled', duplicateCheckEnabled);
if (!duplicateCheckEnabled) {
hideDuplicateWarning();
}
showToast(`Duplicate check ${duplicateCheckEnabled ? 'enabled' : 'disabled'}`, 'info');
}

// EDIT MODE FUNCTIONS
function toggleEditMode() {
if (!isOwner) return;

editMode = !editMode;
const indicator = document.getElementById('editModeIndicator');

if (editMode) {
indicator.classList.add('show');
showToast('Edit mode enabled. Click on any star to edit.', 'info');
} else {
indicator.classList.remove('show');
showToast('Edit mode disabled.', 'info');
}
}

// THOUGHT EDITING FUNCTIONS
function enableThoughtEdit() {
if (!isOwner || currentStarIndex === -1) return;
updateTagOptions();

// Get the current thought
const star = thoughts[currentStarIndex];

// Hide display and show editor
document.getElementById('thoughtDisplay').style.display = 'none';
document.getElementById('thoughtEditorContainer').style.display = 'block';

// Set the editor content
document.getElementById('thoughtEditor').innerHTML = star.html;

// Set the current tag
document.getElementById('tagSelect').value = star.category;

// Update buttons
document.getElementById('editThoughtBtn').style.display = 'none';

// Add save button to actions if not already there
const actionsDiv = document.getElementById('starActions');
if (!document.getElementById('saveThoughtBtn')) {
const saveBtn = document.createElement('button');
saveBtn.id = 'saveThoughtBtn';
saveBtn.className = 'btn-main';
saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Changes';
saveBtn.onclick = saveThoughtEdit;
actionsDiv.insertBefore(saveBtn, actionsDiv.firstChild);
}

// Focus on editor
document.getElementById('thoughtEditor').focus();
}

function saveThoughtEdit() {
if (!isOwner || currentStarIndex === -1) return;

// Get the updated content
const updatedContent = document.getElementById('thoughtEditor').innerHTML;
const updatedText = document.getElementById('thoughtEditor').innerText;
const updatedTag = document.getElementById('tagSelect').value;

if (updatedText.trim() === '') {
showToast('Thought cannot be empty!', 'warning');
return;
}

// Update the thought
thoughts[currentStarIndex].html = updatedContent;
thoughts[currentStarIndex].text = updatedText;
thoughts[currentStarIndex].category = updatedTag;
thoughts[currentStarIndex].date = new Date().toLocaleString('hi-IN') + ' (edited)';

// Save to localStorage
saveThoughts();

// Update the display
document.getElementById('mText').innerHTML = updatedContent;
document.getElementById('mDate').innerText = thoughts[currentStarIndex].date;

// Update categories display
const categoriesDiv = document.getElementById('starCategories');
categoriesDiv.innerHTML = `<span class="category-pill active">${updatedTag}</span>`;

// Hide editor and show display
document.getElementById('thoughtDisplay').style.display = 'block';
document.getElementById('thoughtEditorContainer').style.display = 'none';

// Update buttons
document.getElementById('editThoughtBtn').style.display = 'inline-flex';

// Remove save button
const saveBtn = document.getElementById('saveThoughtBtn');
if (saveBtn) {
saveBtn.remove();
}

// Render stars
renderStars();

// Show success message
showToast('Thought updated successfully! \u{2B50}', 'success');

if (soundEnabled) {
playSound();
}
}

function cancelThoughtEdit() {
if (!isOwner || currentStarIndex === -1) return;

// Hide editor and show display
document.getElementById('thoughtDisplay').style.display = 'block';
document.getElementById('thoughtEditorContainer').style.display = 'none';

// Update buttons
document.getElementById('editThoughtBtn').style.display = 'inline-flex';

// Remove save button
const saveBtn = document.getElementById('saveThoughtBtn');
if (saveBtn) {
saveBtn.remove();
}
}

function formatThoughtText(command) {
if (!isOwner) return;
document.execCommand(command, false, null);
document.getElementById('thoughtEditor').focus();
}

function insertThoughtEmoji() {
if (!isOwner) return;
const emojis = ['\u{2B50}', '\u{1F31F}', '\u{2728}', '\u{1F4AB}', '\u{1F319}', '\u{2600}\u{FE0F}', '\u{1F30D}', '\u{1F680}', '\u{1F47D}', '\u{1F6F8}'];
const emoji = emojis[Math.floor(Math.random() * emojis.length)];
document.getElementById('thoughtEditor').innerHTML += emoji;
document.getElementById('thoughtEditor').focus();
}

// RECYCLE BIN FUNCTIONS
function openRecycleBin() {
if (!isOwner) return;

document.getElementById('recycleBinModal').style.display = 'block';
renderRecycleBin();
}

// NEW FUNCTION: Open Recycle Bin from Log Modal
function openRecycleBinFromLog() {
if (!isOwner) {
showToast('Only the owner can access the recycle bin', 'warning');
return;
}

// Close the log modal first
closeLog();

// Then open the recycle bin modal
setTimeout(() => {
document.getElementById('recycleBinModal').style.display = 'block';
renderRecycleBin();
}, 300);
}

function closeRecycleBin() {
document.getElementById('recycleBinModal').style.display = 'none';
}

function renderRecycleBin() {
const content = document.getElementById('recycleBinContent');

if (deletedThoughts.length === 0) {
content.innerHTML = '<div class="recycle-empty">Recycle bin is empty</div>';
return;
}

content.innerHTML = deletedThoughts.map((thought, index) => {
return `
<div class="recycle-item">
<div class="recycle-item-content">
<div class="recycle-item-meta">
<div class="recycle-item-date">${thought.date}</div>
<div class="recycle-item-category">${thought.category}</div>
</div>
<div class="recycle-item-text">${thought.html}</div>
</div>
<div class="recycle-item-actions">
<button class="btn-secondary" onclick="restoreThought(${index})" title="Restore">
<i class="fas fa-undo"></i>
</button>
<button class="btn-danger" onclick="permanentlyDeleteThought(${index})" title="Delete Forever">
<i class="fas fa-times"></i>
</button>
</div>
</div>
`;
}).join('');
}

function moveToRecycleBin() {
if (!isOwner || currentStarIndex === -1) return;

const thought = thoughts[currentStarIndex];
thought.deletedDate = new Date().toLocaleString('hi-IN');

// Move to recycle bin
deletedThoughts.push(thought);
saveDeletedThoughts();

// Remove from main thoughts
thoughts.splice(currentStarIndex, 1);
saveThoughts();

renderStars();
updateStats();
updateRecycleBinCount();
closeStarModal();
showToast('Thought moved to recycle bin', 'info');
}

function restoreThought(index) {
if (!isOwner) return;

// Get the thought to restore
const thought = deletedThoughts[index];

// Remove from recycle bin
deletedThoughts.splice(index, 1);
saveDeletedThoughts();

// Add back to main thoughts
thoughts.push(thought);
saveThoughts();

renderStars();
updateStats();
updateRecycleBinCount();
renderRecycleBin();
showToast('Thought restored successfully', 'success');
}

function permanentlyDeleteThought(index) {
if (!isOwner) return;

if (confirm('Are you sure you want to permanently delete this thought? This action cannot be undone.')) {
// Remove from recycle bin
deletedThoughts.splice(index, 1);
saveDeletedThoughts();

updateStats();
updateRecycleBinCount();
renderRecycleBin();
showToast('Thought permanently deleted', 'info');
}
}

function emptyRecycleBin() {
if (!isOwner) return;

if (confirm('Are you sure you want to empty the recycle bin? This action cannot be undone.')) {
deletedThoughts = [];
saveDeletedThoughts();

updateStats();
updateRecycleBinCount();
renderRecycleBin();
showToast('Recycle bin emptied', 'info');
}
}

function updateRecycleBinCount() {
if (!isOwner) return;

const count = deletedThoughts.length;
document.getElementById('recycleBinCount').textContent = count;

// Also update the count in the log modal if it exists
const logRecycleCount = document.getElementById('logRecycleCount');
if (logRecycleCount) {
logRecycleCount.textContent = count;
}
}

// DUPLICATE DETECTION
function checkForDuplicates() {
if (!isOwner || !duplicateCheckEnabled) return;

const editor = document.getElementById('editor');
const currentText = editor.innerText.trim().toLowerCase();

if (currentText.length < 5) {
hideDuplicateWarning();
return;
}

// Find similar thoughts
const similarThoughts = thoughts.filter(thought => {
const thoughtText = thought.text.toLowerCase();
return thoughtText.includes(currentText) ||
currentText.includes(thoughtText) ||
calculateSimilarity(currentText, thoughtText) > 0.7;
});

if (similarThoughts.length > 0) {
// Check for exact duplicate
const exactDuplicate = similarThoughts.find(thought =>
thought.text.toLowerCase() === currentText
);

if (exactDuplicate) {
showDuplicateWarning(similarThoughts, true);
} else {
showDuplicateWarning(similarThoughts, false);
}
} else {
hideDuplicateWarning();
}
}

function calculateSimilarity(str1, str2) {
const longer = str1.length > str2.length ? str1 : str2;
const shorter = str1.length > str2.length ? str2 : str1;

if (longer.length === 0) return 1.0;

const editDistance = levenshteinDistance(longer, shorter);
return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(str1, str2) {
const matrix = [];

for (let i = 0; i <= str2.length; i++) {
matrix[i] = [i];
}

for (let j = 0; j <= str1.length; j++) {
matrix[0][j] = j;
}

for (let i = 1; i <= str2.length; i++) {
for (let j = 1; j <= str1.length; j++) {
if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
matrix[i][j] = matrix[i - 1][j - 1];
} else {
matrix[i][j] = Math.min(
matrix[i - 1][j - 1] + 1,
matrix[i][j - 1] + 1,
matrix[i - 1][j] + 1
);
}
}
}

return matrix[str2.length][str1.length];
}

function showDuplicateWarning(similarThoughts, isExact) {
const warningBox = document.getElementById('duplicateWarningBox');
const warningText = document.getElementById('duplicateWarningText');
const similarList = document.getElementById('similarThoughtsList');
const editor = document.getElementById('editor');
const saveButton = document.getElementById('saveButton');

warningBox.classList.add('show');

if (isExact) {
warningBox.classList.add('danger');
warningText.innerHTML = '<i class="fas fa-times-circle"></i> Exact duplicate found!';
editor.classList.add('exact-duplicate');
editor.classList.remove('duplicate-warning');
saveButton.disabled = true;
} else {
warningBox.classList.remove('danger');
warningText.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Similar thoughts found!';
editor.classList.add('duplicate-warning');
editor.classList.remove('exact-duplicate');
saveButton.disabled = false;
}

// Show similar thoughts
similarList.innerHTML = similarThoughts.slice(0, 3).map(thought => {
const similarity = Math.round(calculateSimilarity(
editor.innerText.trim().toLowerCase(),
thought.text.toLowerCase()
) * 100);

return `
<div class="similar-thought-item" onclick="showStarModal(${thoughts.indexOf(thought)})">
<div>${thought.text.substring(0, 100)}${thought.text.length > 100 ? '...' : ''}</div>
<div class="similar-thought-date">
 ${thought.date}
<span class="similarity-score">${similarity}%</span>
</div>
</div>
`;
}).join('');
}

function hideDuplicateWarning() {
const warningBox = document.getElementById('duplicateWarningBox');
const editor = document.getElementById('editor');
const saveButton = document.getElementById('saveButton');

warningBox.classList.remove('show', 'danger');
editor.classList.remove('duplicate-warning', 'exact-duplicate');
saveButton.disabled = false;
}

// EDITOR FUNCTIONS (OWNER ONLY)
function formatText(command) {
if (!isOwner) return;
document.execCommand(command, false, null);
document.getElementById('editor').focus();
}

function selectCategory(element, category) {
if (!isOwner) return;
document.querySelectorAll('#editorCategories .category-pill').forEach(pill => {
pill.classList.remove('active');
});
element.classList.add('active');
selectedCategory = category;
}

function startVoice() {
if (!isOwner) return;

if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
showToast('Speech recognition not supported in your browser', 'error');
return;
}

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = new SpeechRecognition();
recognition.lang = 'hi-IN';
recognition.continuous = false;
recognition.interimResults = false;

recognition.onstart = () => {
showToast('Listening... \u{1F3A4}', 'info');
};

recognition.onresult = (event) => {
const transcript = event.results[0][0].transcript;
document.getElementById('editor').innerHTML += transcript + ' ';
checkForDuplicates();
showToast('Voice added successfully!', 'success');
};

recognition.onerror = () => {
showToast('Voice recognition error. Try again.', 'error');
};

recognition.start();
}

function insertEmoji() {
if (!isOwner) return;
const emojis = ['\u{2B50}', '\u{1F31F}', '\u{2728}', '\u{1F4AB}', '\u{1F319}', '\u{2600}\u{FE0F}', '\u{1F30D}', '\u{1F680}', '\u{1F47D}', '\u{1F6F8}'];
const emoji = emojis[Math.floor(Math.random() * emojis.length)];
document.getElementById('editor').innerHTML += emoji;
document.getElementById('editor').focus();
checkForDuplicates();
}

function saveThought() {
if (!isOwner) return;

const editor = document.getElementById('editor');
const text = editor.innerText.trim();

if(text === "") {
showToast('Please write something before saving!', 'warning');
return;
}

// Check for exact duplicate before saving
if (duplicateCheckEnabled) {
const exactDuplicate = thoughts.find(thought =>
thought.text.toLowerCase() === text.toLowerCase()
);

if (exactDuplicate) {
showToast('This thought already exists! Cannot save duplicate.', 'error');
return;
}
}

const angle = Math.random() * Math.PI * 2;
const dist = Math.random() * 250 + 50;

const star = {
id: Date.now(),
html: editor.innerHTML,
text: text,
date: new Date().toLocaleString('hi-IN'),
category: selectedCategory,
x: (window.innerWidth/2) + Math.cos(angle)*dist,
y: (window.innerHeight/2) + Math.sin(angle)*dist,
color: `hsl(${Math.random()*360}, 100%, 75%)`
};
normalizeStarCoordinates(star);

thoughts.push(star);
saveThoughts();

editor.innerHTML = "";
hideDuplicateWarning();
renderStars();
createShootingStar();
updateStats();
showToast('Star created successfully! \u{2B50}', 'success');

if (soundEnabled) {
playSound();
}
}

// STAR FUNCTIONS
function renderStars() {
const field = document.getElementById('galaxy-field');
field.innerHTML = '';

thoughts.forEach((star, index) => {
const pos = getStarRenderPosition(star);
const starContainer = document.createElement('div');
starContainer.style.position = 'absolute';
starContainer.style.left = `${pos.x}px`;
starContainer.style.top = `${pos.y}px`;

const starElement = document.createElement('div');
starElement.className = 'star-point';
starElement.style.cssText = `width:10px; height:10px; background:${star.color}; box-shadow: 0 0 15px ${star.color}`;

// Add edit button for owners
if (isOwner) {
const editBtn = document.createElement('div');
editBtn.className = 'star-edit-btn';
editBtn.innerHTML = '<i class="fas fa-edit"></i>';
editBtn.onclick = (e) => {
e.stopPropagation();
showStarModal(index);
setTimeout(() => enableThoughtEdit(), 100);
};
starElement.appendChild(editBtn);
}

starElement.onmouseover = (e) => showTooltip(e, star);
starElement.onmouseout = hideTooltip;
starElement.onclick = () => showStarModal(index);

starContainer.appendChild(starElement);
field.appendChild(starContainer);
});

updateTimelineIfOpen();
}

function showTooltip(e, star) {
const tooltip = document.getElementById('tooltip');
const pos = getStarRenderPosition(star);
tooltip.style.display = 'block';
tooltip.innerText = star.text.substring(0, 30) + (star.text.length > 30 ? "..." : "");
tooltip.style.left = (pos.x + 15) + "px";
tooltip.style.top = (pos.y - 15) + "px";
}

function hideTooltip() {
document.getElementById('tooltip').style.display = 'none';
}

function showStarModal(index) {
currentStarIndex = index;
const star = thoughts[index];

// For visitors, show only the date without time
if (!isOwner) {
// Extract just the date part (before the comma)
const dateOnly = star.date.split(',')[0];
document.getElementById('mDate').innerText = dateOnly;
} else {
// For owners, show the full date with time
document.getElementById('mDate').innerText = star.date;
}

document.getElementById('mText').innerHTML = star.html;

const categoriesDiv = document.getElementById('starCategories');
categoriesDiv.innerHTML = `<span class="category-pill active">${star.category}</span>`;

// Update modal actions based on user type
if (isOwner) {
updateStarModalForOwner();
// Set the current tag in the select dropdown
const tagSelect = document.getElementById('tagSelect');
tagSelect.value = star.category;
} else {
updateStarModalForVisitor();
}

// Show display by default
document.getElementById('thoughtDisplay').style.display = 'block';
document.getElementById('thoughtEditorContainer').style.display = 'none';

// Update navigation buttons
updateNavigationButtons();

document.getElementById('starModal').style.display = 'block';
}

function closeStarModal() {
// Make sure to cancel any ongoing edit
if (isOwner && document.getElementById('thoughtEditorContainer').style.display === 'block') {
cancelThoughtEdit();
}

document.getElementById('starModal').style.display = 'none';
currentStarIndex = -1;
}

function updateNavigationButtons() {
const prevBtn = document.getElementById('prevThoughtBtn');
const nextBtn = document.getElementById('nextThoughtBtn');
const counter = document.getElementById('thoughtCounter');

// Update counter
counter.textContent = `${currentStarIndex + 1} / ${thoughts.length}`;

// Enable/disable buttons based on current position
prevBtn.disabled = currentStarIndex <= 0;
nextBtn.disabled = currentStarIndex >= thoughts.length - 1;

// Hide navigation if there's only one thought
if (thoughts.length <= 1) {
prevBtn.style.display = 'none';
nextBtn.style.display = 'none';
counter.style.display = 'none';
} else {
prevBtn.style.display = 'flex';
nextBtn.style.display = 'flex';
counter.style.display = 'block';
}
}

function navigateToPrevThought() {
if (currentStarIndex <= 0) return;

// Cancel any ongoing edit
if (isOwner && document.getElementById('thoughtEditorContainer').style.display === 'block') {
cancelThoughtEdit();
}

currentStarIndex--;
showStarModal(currentStarIndex);
}

function navigateToNextThought() {
if (currentStarIndex >= thoughts.length - 1) return;

// Cancel any ongoing edit
if (isOwner && document.getElementById('thoughtEditorContainer').style.display === 'block') {
cancelThoughtEdit();
}

currentStarIndex++;
showStarModal(currentStarIndex);
}

function editStar() {
if (!isOwner || currentStarIndex === -1) return;

// Get the selected tag from the dropdown
const tagSelect = document.getElementById('tagSelect');
const newTag = tagSelect.value;

// Update the thought with the new tag
thoughts[currentStarIndex].category = newTag;
thoughts[currentStarIndex].date = new Date().toLocaleString('hi-IN') + ' (edited)';

// Save to localStorage
saveThoughts();

// Update the category display
const categoriesDiv = document.getElementById('starCategories');
categoriesDiv.innerHTML = `<span class="category-pill active">${newTag}</span>`;

// Render the updated stars
renderStars();

// Show success message
showToast('Tag updated successfully! \u{2B50}', 'success');

if (soundEnabled) {
playSound();
}
}

function deleteStar() {
if (!isOwner || currentStarIndex === -1) return;

const thought = thoughts[currentStarIndex];
thought.deletedDate = new Date().toLocaleString('hi-IN');

// Move to recycle bin
deletedThoughts.push(thought);
saveDeletedThoughts();

// Remove from main thoughts
thoughts.splice(currentStarIndex, 1);
saveThoughts();

renderStars();
updateStats();
updateRecycleBinCount();
closeStarModal();
showToast('Thought moved to recycle bin', 'info');
}

// LOG FUNCTIONS
function showHistory() {
document.getElementById('logModal').style.display = 'block';

// Update recycle bin count in the log modal
document.getElementById('logRecycleCount').textContent = deletedThoughts.length;

// Update filter categories to include custom categories (without Add button)
updateFilterCategories();

renderLog();
}

function closeLog() {
document.getElementById('logModal').style.display = 'none';
}

function openTimeline() {
document.getElementById('timelineModal').style.display = 'block';
renderTimeline();
}

function closeTimeline() {
document.getElementById('timelineModal').style.display = 'none';
}

function updateTimelineIfOpen() {
const timelineModal = document.getElementById('timelineModal');
if (timelineModal && timelineModal.style.display === 'block') {
renderTimeline();
}
}

function getThoughtTimestamp(star) {
if (!star) return 0;
const cleanedDate = String(star.date || '').replace(' (edited)', '').trim();
const parsedTime = Date.parse(cleanedDate);
if (!Number.isNaN(parsedTime)) {
return parsedTime;
}
const numericId = Number(star.id);
return Number.isFinite(numericId) ? numericId : 0;
}

function renderTimeline() {
const container = document.getElementById('timelineContent');
if (!container) return;

if (!Array.isArray(thoughts) || thoughts.length === 0) {
container.innerHTML = '<div class="timeline-empty">No thoughts yet. Create your first thought.</div>';
return;
}

const sorted = thoughts
.map((star, index) => ({ star, index }))
.sort((a, b) => getThoughtTimestamp(b.star) - getThoughtTimestamp(a.star));

container.innerHTML = sorted.map((item, position) => {
const { star, index } = item;
const safeText = (star.text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const preview = safeText.length > 170 ? `${safeText.slice(0, 170)}...` : safeText;

return `
<div class="timeline-item" onclick="showStarModal(${index}); closeTimeline();">
<div class="timeline-index">${position + 1}</div>
<div>
<div class="timeline-meta">
<span class="timeline-date">${star.date || ''}</span>
<span class="timeline-category">${star.category || 'general'}</span>
</div>
<div class="timeline-text">${preview || '(No text)'}</div>
</div>
</div>
`;
}).join('');
}

function renderLog(filter = 'all') {
const content = document.getElementById('logContent');
let filteredThoughts = filter === 'all' ? thoughts : thoughts.filter(t => t.category === filter);

// Sort thoughts by date (newest first)
filteredThoughts.sort((a, b) => new Date(b.date) - new Date(a.date));

content.innerHTML = filteredThoughts.map((star, i) => {
const index = thoughts.indexOf(star); // Get the original index

// For visitors, show only the date without time
let displayDate;
if (!isOwner) {
// Extract just the date part (before the comma)
displayDate = star.date.split(',')[0];
} else {
// For owners, show the full date with time
displayDate = star.date;
}

return `
<div class="log-item" onclick="openStarFromLog(${index})">
<div class="log-number">${index + 1}</div>
<div class="log-content">
<div class="log-meta">
<div class="log-date">${displayDate}</div>
<div class="log-category">${star.category}</div>
</div>
<div class="log-text">${star.html}</div>
</div>
</div>
`;
}).join('');
}

function openStarFromLog(index) {
if (isOwner) {
// Close log modal first
closeLog();
// Then open star modal with edit/delete options
setTimeout(() => {
showStarModal(index);
}, 300);
} else {
// For visitors, just show the star modal
showStarModal(index);
}
}

function filterByCategory(category) {
document.querySelectorAll('#filterCategories .category-pill').forEach(pill => {
pill.classList.remove('active');
});
event.target.classList.add('active');
renderLog(category);
}

function sortStars(by) {
if (by === 'date') {
thoughts.sort((a, b) => new Date(b.date) - new Date(a.date));
} else if (by === 'text') {
thoughts.sort((a, b) => a.text.localeCompare(b.text));
}
renderLog();
showToast(`Sorted by ${by}`, 'info');
}

// SEARCH FUNCTIONS
function normalizeSearchText(value) {
return String(value || '')
.toLowerCase()
.replace(/\s+/g, ' ')
.trim();
}

function stripHtmlTags(value) {
return String(value || '').replace(/<[^>]*>/g, ' ');
}

function getStarSearchBlob(star) {
if (!star || typeof star !== 'object') return '';
const merged = `${star.text || ''} ${stripHtmlTags(star.html || '')} ${star.category || ''}`;
return normalizeSearchText(merged);
}

function getSearchScore(query, searchBlob) {
if (!query || !searchBlob) return 0;
if (searchBlob.includes(query)) return 1;

const queryWords = query.split(' ').filter((word) => word.length > 1);
if (queryWords.length === 0) {
return calculateSimilarity(query, searchBlob.slice(0, Math.max(60, query.length * 4)));
}

let matchedWords = 0;
let fuzzyScoreTotal = 0;

queryWords.forEach((word) => {
if (searchBlob.includes(word)) {
matchedWords += 1;
fuzzyScoreTotal += 1;
return;
}

const blobWords = searchBlob.split(' ').filter((blobWord) => blobWord.length > 1);
let bestWordScore = 0;

for (let i = 0; i < blobWords.length; i++) {
const score = calculateSimilarity(word, blobWords[i]);
if (score > bestWordScore) bestWordScore = score;
if (bestWordScore > 0.9) break;
}

if (bestWordScore >= 0.65) {
matchedWords += 1;
}
fuzzyScoreTotal += bestWordScore;
});

const coverageScore = matchedWords / queryWords.length;
const averageFuzzyScore = fuzzyScoreTotal / queryWords.length;
return Math.max(coverageScore, averageFuzzyScore);
}

function escapeHtml(text) {
return String(text || '')
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#39;');
}

function hideSearchSuggestions() {
const container = document.getElementById('searchSuggestions');
if (!container) return;
container.classList.remove('show');
container.innerHTML = '';
}

function renderSearchSuggestions(items) {
const container = document.getElementById('searchSuggestions');
if (!container) return;

if (!Array.isArray(items) || items.length === 0) {
container.innerHTML = '<div class="search-suggestion-empty">No matching thoughts.</div>';
container.classList.add('show');
return;
}

const topItems = items.slice(0, 7);
container.innerHTML = topItems.map((item) => {
const previewText = (item.star.text || stripHtmlTags(item.star.html || '') || '').trim();
const preview = previewText.length > 80 ? `${previewText.slice(0, 80)}...` : previewText || '(No text)';
return `
<div class="search-suggestion-item" onclick="openStarFromSearchResult(${item.index})">
<div class="search-suggestion-text">${escapeHtml(preview)}</div>
<div class="search-suggestion-meta">
<span class="search-suggestion-category">${escapeHtml(item.star.category || 'general')}</span>
<span class="search-suggestion-date">${escapeHtml((item.star.date || '').split(',')[0])}</span>
</div>
</div>
`;
}).join('');

container.classList.add('show');
}

function openStarFromSearchResult(index) {
hideSearchSuggestions();
showStarModal(index);
}

function searchStars() {
const query = normalizeSearchText(document.getElementById('searchInput').value);

if (query === '') {
renderStars();
hideSearchSuggestions();
return;
}

const filtered = thoughts
.map((star, index) => ({
index,
star,
score: getSearchScore(query, getStarSearchBlob(star))
}))
.filter((item) => item.score >= 0.55)
.sort((a, b) => b.score - a.score)

renderSearchSuggestions(filtered);

const field = document.getElementById('galaxy-field');
field.innerHTML = '';

filtered.forEach((item) => {
const { star, index } = item;
const pos = getStarRenderPosition(star);
const starContainer = document.createElement('div');
starContainer.style.position = 'absolute';
starContainer.style.left = `${pos.x}px`;
starContainer.style.top = `${pos.y}px`;

const starElement = document.createElement('div');
starElement.className = 'star-point';
starElement.style.cssText = `width:12px; height:12px; background:${star.color}; box-shadow: 0 0 20px ${star.color}`;

// Add edit button for owners
if (isOwner) {
const editBtn = document.createElement('div');
editBtn.className = 'star-edit-btn';
editBtn.innerHTML = '<i class="fas fa-edit"></i>';
editBtn.onclick = (e) => {
e.stopPropagation();
showStarModal(thoughts.indexOf(star));
setTimeout(() => enableThoughtEdit(), 100);
};
starElement.appendChild(editBtn);
}

starElement.onmouseover = (e) => showTooltip(e, star);
starElement.onmouseout = hideTooltip;
starElement.onclick = () => showStarModal(thoughts.indexOf(star));

starContainer.appendChild(starElement);
field.appendChild(starContainer);
});
}

// DATA MANAGEMENT (OWNER ONLY)
function exportData() {
if (!isOwner) return;

// Create CSV content
let csvContent = "ID,Date,Category,Text,HTML,X Position,Y Position,Color\n";

thoughts.forEach(star => {
// Clean the text and HTML to handle commas and quotes
const cleanText = star.text.replace(/"/g, '""');
const cleanHtml = star.html.replace(/"/g, '""');

csvContent += `${star.id},"${star.date}","${star.category}","${cleanText}","${cleanHtml}",${star.x},${star.y},"${star.color}"\n`;
});

// Create blob and download
const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
const url = URL.createObjectURL(blob);
const link = document.createElement('a');
link.setAttribute('href', url);
link.setAttribute('download', `universe-data-${new Date().toISOString().split('T')[0]}.csv`);
link.style.visibility = 'hidden';
document.body.appendChild(link);
link.click();
document.body.removeChild(link);

showToast('Data exported to Excel format successfully! \u{1F4CA}', 'success');
}

function importData() {
if (!isOwner) return;

const input = document.createElement('input');
input.type = 'file';
input.accept = '.csv,.xlsx,.xls';
input.onchange = (e) => {
const file = e.target.files[0];
if (!file) return;

// Show progress modal
document.getElementById('importProgressModal').style.display = 'block';
document.getElementById('importStatus').textContent = 'Reading file...';
document.getElementById('importProgress').style.width = '20%';

const reader = new FileReader();

reader.onload = function(event) {
try {
const csvData = event.target.result;
const lines = csvData.split('\n');

// Skip header line
const dataLines = lines.slice(1);

if (dataLines.length === 0 || dataLines[0] === '') {
showToast('File is empty or has no data!', 'error');
closeImportProgressModal();
return;
}

// Parse CSV data
const importedThoughts = [];
let processedCount = 0;

document.getElementById('importStatus').textContent = 'Processing data...';
document.getElementById('importProgress').style.width = '40%';

for (let i = 0; i < dataLines.length; i++) {
const line = dataLines[i].trim();
if (line === '') continue;

// Parse CSV line handling quoted fields
const fields = parseCSVLine(line);

if (fields.length >= 4) {
const thought = {
id: fields[0] ? parseInt(fields[0]) : Date.now() + i,
date: fields[1] || new Date().toLocaleString('hi-IN'),
category: fields[2] || 'personal',
text: fields[3] || '',
html: fields[4] || fields[3] || '',
x: fields[5] ? parseFloat(fields[5]) : (window.innerWidth/2) + (Math.random() * 200 - 100),
y: fields[6] ? parseFloat(fields[6]) : (window.innerHeight/2) + (Math.random() * 200 - 100),
color: fields[7] || `hsl(${Math.random()*360}, 100%, 75%)`
};
normalizeStarCoordinates(thought);

importedThoughts.push(thought);

// Add custom categories if they don't exist
if (fields[2] && !customCategories.includes(fields[2]) &&
!['personal', 'work', 'ideas'].includes(fields[2].toLowerCase())) {
customCategories.push(fields[2]);
}
}

// Update progress
processedCount++;
const progress = 40 + (processedCount / dataLines.length) * 50;
document.getElementById('importProgress').style.width = `${progress}%`;
}

// Save custom categories
saveCustomCategories();

// Add imported thoughts to existing ones
thoughts = [...thoughts, ...importedThoughts];
saveThoughts();

// Update UI
renderStars();
updateStats();
loadCustomCategories();

// Complete progress
document.getElementById('importStatus').textContent = `Import complete! Added ${importedThoughts.length} thoughts.`;
document.getElementById('importProgress').style.width = '100%';
document.getElementById('importCloseBtn').style.display = 'block';

showToast(`Successfully imported ${importedThoughts.length} thoughts! \u{1F4CA}`, 'success');
} catch (error) {
console.error('Import error:', error);
showToast('Error parsing file. Please check the format.', 'error');
closeImportProgressModal();
}
};

reader.onerror = function() {
showToast('Error reading file!', 'error');
closeImportProgressModal();
};

reader.readAsText(file);
};

input.click();
}

// Helper function to parse CSV line with quoted fields
function parseCSVLine(line) {
const result = [];
let current = '';
let inQuotes = false;

for (let i = 0; i < line.length; i++) {
const char = line[i];

if (char === '"') {
inQuotes = !inQuotes;
} else if (char === ',' && !inQuotes) {
result.push(current);
current = '';
} else {
current += char;
}
}

// Add the last field
result.push(current);

return result;
}

function closeImportProgressModal() {
document.getElementById('importProgressModal').style.display = 'none';
document.getElementById('importProgress').style.width = '0%';
document.getElementById('importCloseBtn').style.display = 'none';
}

function clearAllData() {
if (!isOwner) return;

if (confirm('Are you sure you want to delete all stars? This cannot be undone!')) {
thoughts = [];
saveThoughts();
renderStars();
updateStats();
showToast('All data cleared!', 'info');
}
}

// UTILITY FUNCTIONS
function updateStats() {
if (!isOwner) return;

document.getElementById('totalStars').textContent = thoughts.length;

const firstDate = thoughts.length > 0 ? new Date(thoughts[0].date) : new Date();
const daysActive = Math.ceil((new Date() - firstDate) / (1000 * 60 * 60 * 24));
document.getElementById('daysActive').textContent = daysActive;

const totalWords = thoughts.reduce((sum, star) => sum + star.text.split(' ').length, 0);
document.getElementById('wordsWritten').textContent = totalWords;
}

function createShootingStar() {
const shooting = document.createElement('div');
shooting.className = 'shooting';
shooting.style.top = Math.random() * 50 + '%';
shooting.style.left = Math.random() * 50 + '%';
shooting.style.width = Math.random() * 200 + 100 + 'px';
document.getElementById('universe-container').appendChild(shooting);

setTimeout(() => shooting.remove(), 4000);
}

function createShootingStars() {
setInterval(() => {
if (Math.random() > 0.7) {
createShootingStar();
}
}, 3000);
}

function astronautMessage() {
const messages = isOwner ? [
"Welcome back, Universe Master! \u{1F451}",
"Your thoughts are shining bright! \u{2B50}",
"Keep creating, keep ruling! \u{2728}",
"Your universe is magnificent! \u{1F30C}",
"Infinity is in your hands! \u{1F320}"
] : [
"Exploring the universe of thoughts! \u{1F680}",
"Every star is a memory! \u{2B50}",
"Keep exploring, keep shining! \u{2728}",
"This universe is beautiful! \u{1F30C}",
"Infinity awaits! \u{1F320}"
];
const message = messages[Math.floor(Math.random() * messages.length)];
showToast(message, 'info');
}

// SHIVA MESSAGE FUNCTION
function shivaMessage() {
const messages = [
"I am the creator and destroyer of universes. \u{1F531}",
"In stillness, find the cosmos. \u{1F9D8}\u{200D}\u{2642}\u{FE0F}",
"Your thoughts create your reality. \u{2728}",
"Dance in the cosmic rhythm! \u{1F30C}",
"The third eye sees beyond the visible. \u{1F441}\u{FE0F}",
"I am timeless, formless, eternal. \u{1F549}\u{FE0F}",
"In destruction, there is creation. \u{1F504}",
"Meditate on the infinite within. \u{1F30A}"
];
const message = messages[Math.floor(Math.random() * messages.length)];
showToast(message, 'info');
}

function showToast(message, type = 'info') {
const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toastMessage');

toast.className = 'toast ' + type;
toastMessage.textContent = message;
toast.classList.add('show');

setTimeout(() => {
toast.classList.remove('show');
}, 3000);
}

function playSound() {
if (!soundEnabled) return;

// Create a simple beep sound
const audioContext = new (window.AudioContext || window.webkitAudioContext)();
const oscillator = audioContext.createOscillator();
const gainNode = audioContext.createGain();

oscillator.connect(gainNode);
gainNode.connect(audioContext.destination);

oscillator.frequency.value = 800;
oscillator.type = 'sine';
gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);

oscillator.start(audioContext.currentTime);
oscillator.stop(audioContext.currentTime + 0.5);
}

function shakeElement(element) {
element.style.animation = 'shake 0.5s';
setTimeout(() => {
element.style.animation = '';
}, 500);
}

// Add shake animation
const style = document.createElement('style');
style.textContent = `
@keyframes shake {
0%, 100% { transform: translateX(0); }
25% { transform: translateX(-10px); }
75% { transform: translateX(10px); }
}
`;
document.head.appendChild(style);

// Load saved settings
window.addEventListener('load', () => {
const savedTheme = localStorage.getItem('theme');
if (savedTheme === 'light') {
document.body.classList.add('light-theme');
document.getElementById('themeToggle').checked = true;
}

soundEnabled = localStorage.getItem('soundEnabled') === 'true';
document.getElementById('soundToggle').checked = soundEnabled;

animationsEnabled = localStorage.getItem('animationsEnabled') !== 'false';
document.getElementById('animationToggle').checked = animationsEnabled;

duplicateCheckEnabled = localStorage.getItem('duplicateCheckEnabled') !== 'false';
document.getElementById('duplicateCheck').checked = duplicateCheckEnabled;
});

// Keyboard shortcuts (owner only)
document.addEventListener('keydown', (e) => {
if (!isOwner) return;

if (e.ctrlKey || e.metaKey) {
switch(e.key) {
case 's':
e.preventDefault();
saveThought();
break;
case 'h':
e.preventDefault();
showHistory();
break;
case '/':
e.preventDefault();
document.getElementById('searchInput').focus();
break;
case 'm':
e.preventDefault();
switchMode();
break;
case 'e':
e.preventDefault();
toggleEditMode();
break;
}
}

// Navigation shortcuts in modal
if (document.getElementById('starModal').style.display === 'block') {
if (e.key === 'ArrowLeft') {
navigateToPrevThought();
} else if (e.key === 'ArrowRight') {
navigateToNextThought();
}
}
});
