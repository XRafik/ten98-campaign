import React, { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppIcon as Icon, AppBrand as Brand, AppField as Field, AppBadge, AppStat as Stat, AppSelect } from '@ten98/ui/app';
import { ActivityFeed, Avatar, Badge as UiBadge, BarList, Image, DataTable, type DataColumn, Grid, Meter, ProportionBar, SegmentedControl, Select as UiSelect, SelectableList, Skeleton, Stack, Text } from '@ten98/ui';
import { AccountMenu, SettingsLayout, type SettingsNavItem, type NavLinkComponent, Alert, Card, EmptyState, PageHeader, Progress, SectionNav, ToastProvider, useToast, ConfirmDialog, useConfirmDialog, Dialog, Disclosure, FormGrid, Link, AppShell, AppStateScreen, AppTopbar, AuthErrorBoundary, AuthStory, Button, DangerZoneFlow, FirstUserSetupFlow, FormActions, type IconName, Inline, OidcProviderButtons, ProjectCreateFlow, SearchField, SidebarNav, type SidebarNavItem, SidebarStatus, SignInFlow, StatusLine, WorkspaceCreateFlow, WorkspaceOnboarding, WorkspaceProjectSwitcher } from '@ten98/ui';
// Library sheets only: @ten98/ui owns the page base, tables, fields and the sign-in card.
import '@ten98/ui/app-tokens.css';
import '@ten98/ui/app.css';
import '@ten98/ui/product.css';
import AdComposer from './AdComposer';
import SocialAnalytics from './SocialAnalytics';
import TeamSettings from './TeamSettings';
import { useFocusReturn } from './focus-return';
import CampaignAgent from './CampaignAgent';
import GoogleCalendar from './GoogleCalendar';
import OohMap, { BookingFields } from './OohMap';
import OohProviders from './OohProviders';
import AdDetails from './AdDetails';
import AdCampaignDiscovery from './AdCampaignDiscovery';
import AdsManager from './AdsManager';
import { adsDirectViews, adsManagerViews, adsPath, adsTabs, allAdAccounts, campaignFigure, campaignSortValue, hiddenAmount, readHideAmounts, saveHideAmounts } from './ads-view';
import IntegrationSettings from './IntegrationSettings';
import AccountSettings from './AccountSettings';
import OperationRecovery from './OperationRecovery';
import AcceptInvitation from './AcceptInvitation';
import PostManagement from './PostManagement';
import ContentApprovals from './ContentApprovals';
import ApprovalPolicy from './ApprovalPolicy';
import OpenAIConnection from './OpenAIConnection';
import PostComposer, { accountLabel } from './PostComposer';
import { postScheduleEntries } from '../shared/post-schedule.ts';
import { PLATFORM_RULES } from '../shared/social-posts.ts';
import { adSpendBlock, approvalBadge, approvalGate, readableApprovalSummary, type AdSpendBlock, type ApprovalSummary } from './approval-status';
import AdSpendNotice from './AdSpendNotice';
const ZernioMediaUpload = React.lazy(() => import('./ZernioMediaUpload'));
const ZernioPostLibrary = React.lazy(() => import('./ZernioPostLibrary'));
const ZernioBlogDrafts = React.lazy(() => import('./ZernioBlogDrafts'));
const ZernioProducts = React.lazy(() => import('./ZernioProducts'));
const ProductEditor = React.lazy(() => import('./ZernioProducts').then(module => ({ default: module.ProductEditor })));
const ProductCreator = React.lazy(() => import('./ZernioProducts').then(module => ({ default: module.ProductCreator })));
const ProductPriceEditor = React.lazy(() => import('./ZernioProducts').then(module => ({ default: module.ProductPriceEditor })));
const ProductStateReview = React.lazy(() => import('./ZernioProducts').then(module => ({ default: module.ProductStateReview })));
const CollectionTitleEditor = React.lazy(() => import('./ZernioProducts').then(module => ({ default: module.CollectionTitleEditor })));
const BlogDraftComposer = React.lazy(() => import('./ZernioBlogDrafts').then(module => ({ default: module.BlogDraftComposer })));

const DirectCampaigns = React.lazy(() => import('./DirectCampaigns'));
const UnifiedInbox = React.lazy(() => import('./UnifiedInbox'));
const CampaignLinks = React.lazy(() => import('./CampaignLinks'));
const GoogleAdsTools = React.lazy(() => import('./GoogleAdsTools'));
const NativeGoogleAds = React.lazy(() => import('./NativeGoogleAds'));
const MicrosoftAds = React.lazy(() => import('./MicrosoftAds'));
const ZernioConnection = React.lazy(() => import('./ZernioConnection'));
const ZernioInsights = React.lazy(() => import('./ZernioInsights'));
const ZernioQueues = React.lazy(() => import('./ZernioQueues'));
const ZernioRecycling = React.lazy(() => import('./ZernioRecycling'));
const ZernioLeads = React.lazy(() => import('./ZernioLeads'));
const ZernioDestinations = React.lazy(() => import('./ZernioDestinations'));
const ZernioAdEvents = React.lazy(() => import('./ZernioAdEvents'));
const ZernioContacts = React.lazy(() => import('./ZernioContacts'));
const ZernioWhatsAppTemplates = React.lazy(() => import('./ZernioWhatsAppTemplates'));
const ZernioAccounts = React.lazy(() => import('./ZernioAccounts'));
const ZernioMeasurement = React.lazy(() => import('./ZernioMeasurement'));
const ZernioAdmin = React.lazy(() => import('./ZernioAdmin'));
const ZernioTeam = React.lazy(() => import('./ZernioTeam'));
const CampaignPublishingAgenda = React.lazy(() => import('./PublishingAgenda'));
const OfflineActivations = React.lazy(() => import('./OfflineActivations'));
import AssetLibrary from './AssetLibrary';
import HomeSetup, { type SetupStep } from './HomeSetup';

type Row = { id: string; [key: string]: any };
type State = { user: Row; workspaces: Row[]; projects: Row[]; projectId: string | null; campaigns: Row[]; posts: Row[]; placements: Row[]; activations?: Row[]; assets: Row[]; providers: Row[]; activity: Row[]; connections: { zernio: boolean; drive: boolean } };
type Page = 'Overview' | 'Campaigns' | 'Publishing' | 'Calendar' | 'Ads manager' | 'OOH media' | 'Asset library' | 'Media providers' | 'Analytics' | 'Settings' | 'Draft content' | 'Integrations' | 'Approvals' | 'Direct campaigns' | 'Unified inbox' | 'Links & tracking' | 'Field activity';
const pageRoutes: Record<Page, string> = { Overview: 'overview', Campaigns: 'campaigns', Publishing: 'publishing', Calendar: 'calendar', 'Ads manager': 'ads', 'OOH media': 'ooh', 'Asset library': 'assets', 'Media providers': 'providers', Analytics: 'analytics', Settings: 'settings', 'Draft content': 'draft-content', Integrations: 'integrations', Approvals: 'approvals', 'Direct campaigns': 'direct', 'Unified inbox': 'inbox', 'Links & tracking': 'links', 'Field activity': 'activations' };
const pageSections: Partial<Record<Page, string[]>> = { Publishing: ['posts', 'library', 'queues', 'recycling', 'destinations'], 'Ads manager': ['campaigns', 'adsets', 'ads', 'leads', 'measurement', 'events', 'search', 'shopping', 'microsoft'], Analytics: ['summary', 'accounts'], 'Direct campaigns': ['campaigns', 'templates', 'contacts', 'people'], Settings: ['general', 'approvals', 'activity', 'members', 'profile', 'security', 'sign-in'] };
type Navigation = { page: Page; section: string; projectId: string };
function readNavigation(search: string): Navigation {
  const params = new URLSearchParams(search), view = params.get('view');
  const page = (Object.keys(pageRoutes) as Page[]).find(label => pageRoutes[label] === view) || (view === 'assistant' ? 'Draft content' : 'Overview');
  const sections = pageSections[page] || [];
  return { page, section: sections.includes(params.get('section') || '') ? params.get('section')! : sections[0] || '', projectId: params.get('project') || '' };
}
function navigationUrl(next: Navigation, href: string) {
  const url = new URL(href); url.searchParams.set('view', pageRoutes[next.page]);
  if (next.section && next.section !== pageSections[next.page]?.[0]) url.searchParams.set('section', next.section); else url.searchParams.delete('section');
  if (next.projectId) url.searchParams.set('project', next.projectId); else url.searchParams.delete('project');
  return url.pathname + url.search + url.hash;
}
function editorValues(dialog: ParentNode) {
  return JSON.stringify(Array.from(dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select'), input => [input.tagName, input.name, input.type, input.value, 'checked' in input ? input.checked : null, 'files' in input ? Array.from(input.files || [], file => [file.name, file.size, file.lastModified]) : null]));
}
// Seven work areas plus Settings. Each area shows its pages as tabs; every page keeps its own ?view=&section= URL,
// so bookmarks and links from before the regroup still open the same screen. A tab lists the page sections it shows,
// so one page's sections can live in different areas (Publishing: posts in Planner, imports in Library, posting times in Settings).
type AreaTab = { page: Page; sections?: string[]; label: string };
type Area = { id: string; label: string; icon: IconName; tabs: AreaTab[] };
const areas: Area[] = [
  { id: 'home', label: 'Home', icon: 'grid', tabs: [{ page: 'Overview', label: 'Home' }] },
  { id: 'planner', label: 'Planner', icon: 'calendar', tabs: [{ page: 'Calendar', label: 'Calendar' }, { page: 'Publishing', sections: ['posts', 'recycling'], label: 'Posts' }, { page: 'Campaigns', label: 'Campaigns' }, { page: 'Approvals', label: 'Approvals' }, { page: 'Draft content', label: 'Write with AI' }] },
  { id: 'messages', label: 'Messages', icon: 'inbox', tabs: [{ page: 'Unified inbox', label: 'Inbox' }, { page: 'Direct campaigns', sections: ['campaigns'], label: 'Email & SMS' }, { page: 'Direct campaigns', sections: ['people', 'contacts'], label: 'Contacts' }, { page: 'Direct campaigns', sections: ['templates'], label: 'WhatsApp templates' }] },
  { id: 'ads', label: 'Ads', icon: 'target', tabs: [{ page: 'Ads manager', label: 'Ads' }] },
  { id: 'offline', label: 'Offline', icon: 'billboard', tabs: [{ page: 'OOH media', label: 'Billboards' }, { page: 'Field activity', label: 'Field activity' }, { page: 'Media providers', label: 'Partners' }] },
  { id: 'library', label: 'Library', icon: 'image', tabs: [{ page: 'Asset library', label: 'Media' }, { page: 'Links & tracking', label: 'Links & QR codes' }, { page: 'Publishing', sections: ['library'], label: 'From your accounts' }] },
  { id: 'reports', label: 'Reports', icon: 'chart', tabs: [{ page: 'Analytics', sections: ['summary'], label: 'Overview' }, { page: 'Analytics', sections: ['accounts'], label: 'Social accounts' }] },
  { id: 'settings', label: 'Settings', icon: 'settings', tabs: [{ page: 'Settings', label: 'General' }, { page: 'Integrations', label: 'Connections' }, { page: 'Publishing', sections: ['queues', 'destinations'], label: 'Posting times' }] },
];
// The tab showing a page and section; a tab without sections covers every section of its page.
const areaTab = (page: Page, section: string) => areas.flatMap(area => area.tabs).find(tab => tab.page === page && (!tab.sections || tab.sections.includes(section)))!;
const areaOf = (page: Page, section: string) => areas.find(area => area.tabs.includes(areaTab(page, section)))!;
const channels: Record<string, string> = { mixed: 'Cross-channel', social: 'Social media', paid: 'Paid media', ooh: 'Out of home' };
// Set by the app while someone is signed in. A 401 outside /auth/ means the session expired or was ended elsewhere;
// sign-in failures under /auth/ stay ordinary errors for the sign-in form.
let endSession: (() => void) | null = null;
async function api(path: string, method = 'GET', body?: unknown, key?: string) {
  const response = await fetch('/api' + path, { method, credentials: 'same-origin', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  if (response.status === 401 && !path.startsWith('/auth/') && endSession) { endSession(); throw new DOMException('Your session ended. Sign in again.', 'AbortError'); }
  const data = await response.json().catch(() => { throw new Error('The server returned an unreadable response.'); });
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The server returned an unreadable response.');
  if (!response.ok) throw Object.assign(new Error(typeof data.error === 'string' ? data.error : data.error?.message || 'The request could not be completed.'), { status: response.status, code: data.error?.code, details: data.error?.details, operation: data.operation, run: data.run });
  return data;
}
const money = (n: unknown, currency = 'AED') => numeric(n) ? new Intl.NumberFormat('en-AE', { style: 'currency', currency, minimumFractionDigits: 0 }).format(n) : '—';
const compact = (n: unknown) => numeric(n) ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n) : '—';
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const budgetProgress = (spent: unknown, budget: unknown) => numeric(spent) && numeric(budget) && budget > 0 ? Math.min(100, Math.max(0, spent / budget * 100)) : 0;
const title = (s: string) => s === 'openai' ? 'ChatGPT' : PLATFORM_RULES[s]?.label || (s ? s.charAt(0).toUpperCase() + s.slice(1).replaceAll('_', ' ') : '');
const date = (value: string) => value ? new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(/^\d{4}-\d{2}-\d{2}$/.test(value) ? { timeZone: 'UTC' } : {}) }) : 'Not set';
// The search shortcut accepts Ctrl or Command; the hint names the key this device uses.
const searchShortcut = /Mac|iPhone|iPad/.test(globalThis.navigator?.userAgent || '') ? '⌘ K' : 'Ctrl K';
const initial = (value: string) => value?.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase() || '98';
function upcomingPosts(posts: Row[], now = Date.now(), accounts: Row[] = []) { return posts.flatMap(post => postScheduleEntries(post, accounts)).filter(entry => ['draft', 'scheduled', 'submitted'].includes(entry.post.status) && Date.parse(entry.scheduledAt) > now).sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt)); }
function postLabel(post: Row) { return post.content?.trim() || post.platforms?.map((platform: string) => post.platformOverrides?.[platform]?.content?.trim()).find(Boolean) || (Object.values(post.accountOverrides || {}) as Row[]).map(variant => variant?.content?.trim()).find(Boolean) || (([post, ...Object.values(post.platformOverrides || {}), ...Object.values(post.accountOverrides || {})] as Row[]).some(variant => variant?.assetId || variant?.mediaItems?.length) ? 'Media post' : 'Empty draft'); }
function postRecipients(post: Row, accounts: Row[] = []) {
  if (!Array.isArray(post.accounts)) return 'Choose connected accounts';
  if (!post.accounts.length) return 'No accounts selected';
  return post.accounts.map((id: string) => {
    const account = accounts.find(account => String(account._id || account.id) === id) || post.providerResults?.find((result: Row) => result.accountId && typeof result.accountId === 'object' && String(result.accountId._id || result.accountId.id) === id)?.accountId;
    const label = account ? accountLabel(account) : id;
    return label === id ? id : `${label} (${id})`;
  }).join(', ');
}
function calendarOverlayEvents(events: Row[], entries: any[], projectId: string) { return events.filter(event => !entries.some(entry => event.managed === true && event.projectId === projectId && event.plan?.collection === 'posts' && event.plan.recordId === entry.post.id && (event.plan.accountId || '') === (entry.accountId || '') && Date.parse(event.start?.dateTime) === Date.parse(entry.scheduledAt) && Date.parse(event.end?.dateTime) === Date.parse(entry.scheduledAt) + 1800000 && event.summary === `Social · ${entry.accountId && !entry.platform ? 'Selected account post' : entry.content.slice(0, 100)}`)); }
function Badge({ value }: { value: string }) { return <AppBadge value={value} label={title(value || 'draft')}/>; }
function AssetPreview({ item }: { item: Row }) {
  const [failed, setFailed] = useState<string[]>([]);
  const kind = item.deliverySource === 'zernio' ? item.deliveryKind : item.kind;
  const previews = [item.deliverySource === 'zernio' ? '' : item.thumbnailUrl, kind === 'image' ? item.deliveryUrl || item.url : ''].flatMap(value => {
    try { const target = new URL(value); return target.protocol === 'https:' && !['drive.google.com', 'docs.google.com'].includes(target.hostname) && !target.username && !target.password && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/i.test(target.hostname) && !/^172\.(1[6-9]|2\d|3[01])\./.test(target.hostname) && !/\.(local|internal)$/i.test(target.hostname) ? [target.href] : []; } catch { return []; }
  });
  const preview = previews.find(value => !failed.includes(value));
  return preview ? <Image key={preview} src={preview} alt={item.description || item.name} aspect="video" fit="cover" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(previous => [...previous, preview])}/> : <Stack gap={1} align="center"><Icon name={kind === 'document' ? 'folder' : 'image'} size={42}/><Text tone="muted" size="sm">{title(kind)}</Text></Stack>;
}
// Sample projects show a labelled placeholder instead of real media.
function Creative({ item, small = false }: { item: Row; small?: boolean }) { return !item.sample ? <AssetPreview item={item}/> : <Stack gap={1} align="center"><Icon name={item.kind === 'document' ? 'folder' : 'image'} size={small ? 28 : 42}/><Text weight="semibold" align="center" preserveWhitespace>{item.kind === 'document' ? 'The brand\nplaybook.' : item.kind === 'video' ? 'Make your\nnext move.' : 'Made to\nstand out.'}</Text><Text tone="muted" size="sm">{item.kind === 'video' ? 'Brand film' : item.kind === 'document' ? 'Brand guidelines · 2026' : 'A new perspective'}</Text></Stack>; }

function App() {
  const [session, setSession] = useState<any>(null), [state, setState] = useState<State | null>(null), { toast } = useToast();
  // inviteSignIn is set while an invited person signs in instead; it carries the invited email for the sign-in form.
  const [inviteToken, setInviteToken] = useState(startupInvite), [inviteSignIn, setInviteSignIn] = useState<{ email?: string } | null>(startupAuthError ? {} : null);
  const [navigation, setNavigation] = useState(() => readNavigation(window.location.search)), [query, setQuery] = useState(''), [tab, setTab] = useState('all');
  const { page, section } = navigation;
  const adsView = page === 'Ads manager' ? section : 'campaigns', publishingView = page === 'Publishing' ? section : 'posts', insightsView = page === 'Analytics' ? section : 'summary', directView = page === 'Direct campaigns' ? section : 'campaigns';
  const navigationRef = useRef(navigation); navigationRef.current = navigation;
  const historyIndex = useRef(Number.isSafeInteger(window.history.state?.campaignIndex) ? window.history.state.campaignIndex : 0), restoringPop = useRef<(() => void) | null>(null);
  const [publishing, setPublishing] = useState<Row | null>(null), [confirm, confirmDialog] = useConfirmDialog();
  const [modal, setModal] = useState<{ type: string; item?: Row; day?: string } | null>(null);
  const modalRef = useRef(modal); modalRef.current = modal;
  const [draftDirty, setDraftDirty] = useState(false), [discardPrompt, setDiscardPrompt] = useState(false);
  const [inboxDirty, setInboxDirty] = useState(false), inboxDraft = useRef({ dirty: false, revision: 0 });
  const discardSwitch = useRef(false);
  const discardAction = useRef<(() => void) | null>(null), dirtyScopes = useRef(new Map<Element, number>());
  const [inboxTarget, setInboxTarget] = useState<{ channel: 'sms' | 'whatsapp'; accountId?: string; search?: string; projectId: string } | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const rememberFocus = useFocusReturn(busy); // A failed owner setup or sign-in returns focus to the control that submitted it.
  const [mobile, setMobile] = useState(false), [currency, setCurrency] = useState('AED');
  const [remote, setRemote] = useState<any>({}), [connectionRevision, setConnectionRevision] = useState(0);
  const [oohInventory, setOohInventory] = useState<Row[]>([]), [calendarEvents, setCalendarEvents] = useState<Row[]>([]);
  const [approvalSummary, setApprovalSummary] = useState<ApprovalSummary | null>(null), [spendBlock, setSpendBlock] = useState<AdSpendBlock | null>(null);
  const mapLocations = useMemo(() => [...(state?.placements || []), ...oohInventory.filter(row => !state?.placements.some(placement => placement.source === 'broadsign' && Number(placement.screenId) === Number(row.id))).map(row => ({ ...row, id: 'screen:' + row.id, locationSource: 'provider' }))], [state?.placements, oohInventory]);
  const [calendar, setCalendar] = useState(new Date(new Date().getFullYear(), new Date().getMonth(), 1)), [calendarView, setCalendarView] = useState<'week' | 'month' | 'list'>('week');
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null), [composerActions, setComposerActions] = useState<HTMLElement | null>(null);
  const pendingKeys = useRef(new Map<string, string>());
  const loadVersion = useRef(0), activeProject = useRef(''), pendingWork = useRef(0);
  const nameFlow = !!modal && ['workspace', 'project'].includes(modal.type);
  const providerManaged = !!modal?.item && ((modal.type === 'placement' && modal.item.source === 'broadsign') || (modal.type === 'campaign' && (modal.item.externalId || modal.item.nativeProvider)));
  const canMap = !!state?.user.isOperator && ['owner', 'admin'].includes(state?.workspaces.find(w => w.id === state?.projects.find(p => p.id === state.projectId)?.workspaceId)?.role);
  const project = state?.projects.find(p => p.id === state.projectId);
  const workspace = state?.workspaces.find(w => w.id === project?.workspaceId);
  const canWrite = !!workspace && workspace.role !== 'viewer', canAdmin = ['owner', 'admin'].includes(workspace?.role);
  const sample = state && [state.campaigns, state.posts, state.placements, state.assets, state.providers].some(rows => rows.some(row => row.sample));
  const endpoint = (suffix: string) => `/projects/${state!.projectId}/${suffix}`;
  function markEditorDirty(target: Element) {
    const scope = target.closest('form') || target.closest('section') || dialogRef.current;
    if (scope && dialogRef.current?.contains(scope)) { dirtyScopes.current.set(scope, (dirtyScopes.current.get(scope) || 0) + 1); setDraftDirty(true); }
  }
  function editorSaved(scope: Element, revision = dirtyScopes.current.get(scope)) {
    if (dirtyScopes.current.get(scope) === revision) { dirtyScopes.current.delete(scope); setDraftDirty(dirtyScopes.current.size > 0); }
  }
  function inboxDraftChanged(dirty: boolean) {
    if (dirty) inboxDraft.current.revision++;
    inboxDraft.current.dirty = dirty; setInboxDirty(dirty);
  }
  async function shortenPostLinks(draft: Record<string, any>) {
    const projectId = state!.projectId, replacements = new Map<string, string>();
    const current = () => { if (activeProject.current !== projectId) throw new DOMException('Project changed.', 'AbortError'); };
    current(); const existing = await api(`/projects/${projectId}/links`); current();
    for (const link of existing.links || []) if (!link.archived) replacements.set(link.shortUrl, link.shortUrl);
    function destinationOf(token: string) {
      const extra: Record<string, number> = { ')': token.split(')').length - token.split('(').length, ']': token.split(']').length - token.split('[').length };
      let end = token.length;
      while (end && (/[.,!?:;]/.test(token[end - 1]) || extra[token[end - 1]] > 0)) { if (token[end - 1] in extra) extra[token[end - 1]]--; end--; }
      return token.slice(0, end);
    }
    async function caption(value: string) {
      // ponytail: recognize plain-text HTTPS tokens; use Links & tracking for URLs with ambiguous trailing punctuation.
      const urls = [...new Set((value.match(/https:\/\/[^\s<>"']+/g) || []).map(destinationOf).filter(url => !url.includes('{{') && !url.includes('}}')))];
      if (urls.length > 10) throw new Error('Shorten at most ten distinct URLs per caption.');
      for (const destination of urls) {
        if (!replacements.has(destination)) {
          current(); const result = await api(`/projects/${projectId}/links`, 'POST', { name: new URL(destination).hostname, destination, ...(draft.campaignId ? { campaignId: draft.campaignId } : {}) }); current();
          replacements.set(destination, result.link.shortUrl);
        }
      }
      return value.replace(/https:\/\/[^\s<>"']+/g, token => { const destination = destinationOf(token); return (replacements.get(destination) || destination) + token.slice(destination.length); });
    }
    current(); const content = await caption(draft.content || ''), platformOverrides: Record<string, any> = {};
    for (const [platform, variant] of Object.entries(draft.platformOverrides || {}) as [string, any][]) platformOverrides[platform] = { ...variant, ...(typeof variant.content === 'string' ? { content: await caption(variant.content) } : {}) };
    const accountOverrides: Record<string, any> = {};
    for (const [id, variant] of Object.entries(draft.accountOverrides || {}) as [string, any][]) accountOverrides[id] = { ...variant, ...(typeof variant.content === 'string' ? { content: await caption(variant.content) } : {}) };
    current(); return { content, platformOverrides, ...(draft.accountOverrides ? { accountOverrides } : {}) };
  }
  const filtered = (rows: Row[]) => rows.filter(row => !query || JSON.stringify(row).toLowerCase().includes(query.toLowerCase()));
  async function shortenEditorLinks(draft: Record<string, any>) {
    const opened = modalRef.current, form = dialogRef.current?.querySelector<HTMLInputElement>('input[name="draftSnapshot"]')?.form, result = await shortenPostLinks(draft);
    if (opened && modalRef.current === opened && form && JSON.stringify([result.content, result.platformOverrides, result.accountOverrides || {}]) !== JSON.stringify([draft.content || '', draft.platformOverrides || {}, draft.accountOverrides || {}])) markEditorDirty(form);
    return result;
  }
  async function editorIntegrate(path: string, body?: any, validate?: (result: any) => void, outcomeOnly = false) {
    const opened = modalRef.current, form = document.activeElement?.closest('form'), revision = form ? dirtyScopes.current.get(form) : undefined;
    const result = await integrate(path, body, validate, outcomeOnly);
    if (opened && modalRef.current === opened && form && dirtyScopes.current.get(form) === revision && (['social/update', 'social/edit-published'].includes(path) && result.post || path === 'social/update-metadata' && validate && result.metadataAcceptance || /^blogs\/[^/]+\/[^/]+\/(?:create|articles\/[^/]+\/update)$/.test(path) && validate && result.operation?.status === 'complete' && result.article || /^products\/[^/]+\/(?:create|[^/]+\/(?:update|price|deactivate|archive|activate))$/.test(path) && validate && result.operation?.status === 'complete' && result.readback === true && result.product || /^products\/[^/]+\/[^/]+\/delete$/.test(path) && validate && result.operation?.status === 'complete' && result.readback === true && result.deletionAcceptance || /^products\/[^/]+\/collections\/[^/]+\/rename$/.test(path) && validate && result.operation?.status === 'complete' && result.readback === true && result.collection)) editorSaved(form, revision);
    return result;
  }
  function writeNavigation(next: Navigation, mode: 'push' | 'replace' | 'pop' = 'push') {
    const url = navigationUrl(next, window.location.href), current = window.location.pathname + window.location.search + window.location.hash;
    if (mode === 'push' && url !== current) window.history.pushState({ ...window.history.state, campaignIndex: ++historyIndex.current }, '', url);
    else if (mode !== 'pop') window.history.replaceState({ ...window.history.state, campaignIndex: historyIndex.current }, '', url);
    if (navigationRef.current.page === 'Unified inbox' && (next.page !== 'Unified inbox' || next.projectId !== navigationRef.current.projectId)) inboxDraftChanged(false);
    navigationRef.current = next; setNavigation(next);
  }
  async function reload(id = state?.projectId || '', nextRoute?: Navigation, mode: 'push' | 'replace' | 'pop' = 'replace') {
    const knownProject = state?.projects.some(project => project.id === id);
    const version = ++loadVersion.current, inboxRevision = inboxDraft.current.revision; activeProject.current = knownProject ? id : state?.projectId || ''; setLoading(true);
    try {
      let next = await api('/state' + (knownProject && id ? '?projectId=' + encodeURIComponent(id) : ''));
      if (version !== loadVersion.current) return;
      if (id && id !== next.projectId) {
        if (next.projects.some((project: Row) => project.id === id)) next = await api('/state?projectId=' + encodeURIComponent(id));
        else if (state) throw new Error('That project is unavailable.');
        else setNotice('The linked project is unavailable. Showing a project you can access.');
      }
      if (version === loadVersion.current) {
        if (next.projectId && !next.projects.some((project: Row) => project.id === next.projectId)) throw new Error('The selected project could not be verified.');
        if (next.projectId !== state?.projectId && inboxDraft.current.dirty && inboxDraft.current.revision !== inboxRevision) throw new Error('Your inbox draft changed while the project was loading. Switch projects again to discard it.');
        activeProject.current = next.projectId || ''; setState(next);
        writeNavigation({ ...(nextRoute || navigationRef.current), projectId: next.projectId || '' }, mode);
      }
    }
    catch (error) { if (version === loadVersion.current) activeProject.current = state?.projectId || ''; throw error; }
    finally { if (version === loadVersion.current) setLoading(false); }
  }
  function leaveEditor(action: () => void, includeInbox = false) {
    if (modalRef.current && draftDirty || includeInbox && inboxDraft.current.dirty) { discardSwitch.current = includeInbox; discardAction.current = action; setDiscardPrompt(true); }
    else action();
  }
  // The discard prompt is a second modal dialog, so the editor's native focus return lands on a closed dialog; refocus its opener.
  function closeEditor() { leaveEditor(() => { const trigger = triggerRef.current; setModal(null); setTimeout(() => { if (trigger?.isConnected && !modalRef.current) trigger.focus(); }, 0); }); }
  function keepEditing() { discardAction.current = null; setDiscardPrompt(false); }
  function discardChanges() {
    const action = discardAction.current; discardAction.current = null;
    dirtyScopes.current.clear(); setDraftDirty(false); setDiscardPrompt(false); action?.();
  }
  function cancelEditor(event?: { preventDefault(): void }) {
    event?.preventDefault(); if (discardPrompt) keepEditing(); else closeEditor();
  }
  function navigate(next: Navigation, mode: 'push' | 'replace' | 'pop' = 'push', popDelta = 0, discardConfirmed = false) {
    if (next.page === navigationRef.current.page && next.section === navigationRef.current.section && next.projectId === navigationRef.current.projectId) {
      if (activeProject.current !== next.projectId) { ++loadVersion.current; activeProject.current = next.projectId; setLoading(false); }
      return;
    }
    const action = () => {
      setModal(null);
      void run(async () => {
        if (next.projectId && !state?.projects.some(project => project.id === next.projectId)) throw new Error('That project is unavailable.');
        let requestVersion = loadVersion.current;
        try {
          if (next.projectId !== (state?.projectId || '')) { const request = reload(next.projectId, next, mode); requestVersion = loadVersion.current; await request; }
          else {
            if (activeProject.current !== next.projectId) { ++loadVersion.current; activeProject.current = next.projectId; setLoading(false); }
            writeNavigation(next, mode);
          }
        } catch (error) {
          if (requestVersion !== loadVersion.current) throw new DOMException('Navigation changed.', 'AbortError');
          if (mode === 'pop' && popDelta) { historyIndex.current -= popDelta; restoringPop.current = () => {}; window.history.go(-popDelta); }
          throw error;
        }
      });
    };
    if (discardConfirmed) action(); else leaveEditor(action, true);
  }
  function clearSignedInState() {
    ++loadVersion.current; activeProject.current = ''; pendingKeys.current.clear(); signedOutFocus.current = true;
    inboxDraftChanged(false); setState(null); setRemote({}); setModal(null);
  }
  function signOut() {
    leaveEditor(() => { void run(async () => {
      await api('/auth/logout', 'POST', {}); clearSignedInState();
      // The next sign-in, possibly by someone else, starts at the overview instead of this person's page and project.
      const url = new URL(window.location.href); for (const key of ['view', 'section', 'project']) url.searchParams.delete(key);
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash); navigationRef.current = readNavigation(''); setNavigation(navigationRef.current);
      setSession(await api('/session'));
    }); }, true);
  }
  // The address keeps the page and project, so signing in again returns there. Unsaved editor or inbox drafts are
  // not kept (editors are uncontrolled forms), so the sign-in screen says they were lost. This runs from the api()
  // 401 hook with a closure from the last session change, so it reads the draft refs rather than draftDirty.
  function sessionExpired() {
    const unsavedChangesLost = !!modalRef.current && dirtyScopes.current.size > 0 || inboxDraft.current.dirty;
    clearSignedInState(); discardAction.current = null; setDiscardPrompt(false); setPublishing(null); setError('');
    setSession((current: any) => ({ ...current, user: null, sessionEnded: true, ...(unsavedChangesLost ? { unsavedChangesLost } : {}) }));
  }
  function setPage(next: Page, nextSection = pageSections[next]?.[0] || '') { navigate({ page: next, section: nextSection, projectId: state?.projectId || '' }); }
  function setAdsView(next: string) { setPage('Ads manager', next); }
  function setPublishingView(next: string) { setPage('Publishing', next); }
  function changeProject(projectId: string) { navigate({ ...navigationRef.current, projectId }); }
  function watchEditorButtons(event: React.MouseEvent<HTMLElement>) {
    const dialog = event.currentTarget, opened = modalRef.current;
    const button = (event.target as HTMLElement).closest('button');
    if (!button || button.getAttribute('role') === 'tab' || button.type !== 'button' || !opened) return;
    const scopes = Array.from(dialog.querySelectorAll<HTMLFormElement>('form')), before = scopes.map(editorValues), revisions = scopes.map(scope => dirtyScopes.current.get(scope));
    setTimeout(() => { if (modalRef.current === opened) scopes.forEach((scope, index) => { if (scope.isConnected && dirtyScopes.current.get(scope) === revisions[index] && editorValues(scope) !== before[index]) markEditorDirty(scope); }); }, 0);
  }
  async function run(work: () => Promise<any>, success?: string) {
    const requestProject = activeProject.current;
    pendingWork.current++;
    setBusy(true); setError(''); setSpendBlock(null);
    try { const result = await work(); if (success && activeProject.current === requestProject) { setNotice(success); } return result; }
    catch (err) {
      // A held-back spend change explains itself; the review it opened updates the Approvals badge.
      const block = adSpendBlock(err);
      if (activeProject.current === requestProject && block) { setSpendBlock(block); if (block.review) void loadApprovalSummary(requestProject); }
      else if (activeProject.current === requestProject && (err as Error).name !== 'AbortError') setError((err as Error).message);
      return null;
    }
    finally { setBusy(--pendingWork.current > 0); }
  }
  async function integrate(path: string, body?: any, validate?: (result: any) => void, outcomeOnly = false) {
    const requestProject = state!.projectId;
    if (activeProject.current !== requestProject) throw new DOMException('Project changed', 'AbortError');
    const operation = `${requestProject}:${path}:${JSON.stringify(body)}`;
    if (outcomeOnly && !pendingKeys.current.has(operation)) throw Object.assign(new Error('The original action key is unavailable. Review Provider outcomes before preparing another action.'), { code: 'OPERATION_OUTCOME_UNAVAILABLE' });
    if (!pendingKeys.current.has(operation)) pendingKeys.current.set(operation, crypto.randomUUID());
    try {
      const result = await api(endpoint('integrations/' + path) + (outcomeOnly ? (path.includes('?') ? '&' : '?') + 'check=1' : ''), body === undefined ? 'GET' : 'POST', body, pendingKeys.current.get(operation));
      validate?.(result);
      pendingKeys.current.delete(operation); if (activeProject.current !== requestProject) throw new DOMException('Project changed', 'AbortError'); return result;
    } catch (error) { const failure = error as Error & { status?: number; code?: string; operation?: { status?: string } }; if (failure.operation?.status === 'failed' || failure.status && failure.status < 500 && !['OPERATION_UNCERTAIN', 'OPERATION_PENDING', 'OPERATION_IN_PROGRESS', 'OPERATION_OUTCOME_UNAVAILABLE', 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED', 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED'].includes(failure.code || '')) pendingKeys.current.delete(operation); throw error; }
  }
  useEffect(() => { if (!notice) return; toast(notice); setNotice(''); }, [notice]); // The shared toast region announces notices and times them out.
  useEffect(() => { window.history.replaceState({ ...window.history.state, campaignIndex: historyIndex.current }, ''); }, []);
  useEffect(() => watchInvite(window, token => { setInviteSignIn(null); setInviteToken(token); }), []);
  useEffect(() => { api('/session').then(s => { setSession(s); if (s.user) reload(new URLSearchParams(window.location.search).get('project') || '').catch(e => { if (e.name !== 'AbortError') setError(e.message); }); }).catch(e => setError(e.message)); }, []);
  useEffect(() => { setQuery(''); setTab('all'); setMobile(false); setError(''); }, [page]);
  useEffect(() => { if (modal) setError(''); }, [modal]); // A dialog shows only its own errors, not one left by an earlier page action.
  useEffect(() => { document.querySelector<HTMLElement>('nav[aria-label="Main navigation"] [aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [page, project?.id, mobile]);
  useEffect(() => { if (!state?.projectId) return; setRemote({}); setOohInventory([]); setCalendarEvents([]); setModal(null); const id = state.projectId; api(endpoint('integrations/status')).then(status => { if (activeProject.current === id) setRemote((r: any) => ({ ...r, status })); }).catch(() => {}); }, [state?.projectId]);
  // The approvals summary labels the Approvals badge and gates Publish; when it cannot be read, Publish stays and the server decides.
  async function loadApprovalSummary(projectId: string) {
    try { const summary = await api(`/projects/${encodeURIComponent(projectId)}/approvals/summary`); if (activeProject.current === projectId) setApprovalSummary(readableApprovalSummary(summary) ? summary : null); }
    catch { if (activeProject.current === projectId) setApprovalSummary(null); }
  }
  useEffect(() => { setApprovalSummary(null); }, [state?.projectId]);
  useEffect(() => { setError(''); }, [section, state?.projectId]); // An earlier action's error does not follow you to another section or project.
  useEffect(() => { if (state?.projectId) void loadApprovalSummary(state.projectId); }, [state]);
  useEffect(() => {
    if (!state?.projectId || !['Overview', 'Calendar'].includes(page) || !state.posts.some(post => Object.keys(post.accountOverrides || {}).length) || remote.accounts || !remote.status?.zernio?.configured || !remote.status.zernio.mapped) return;
    void loadRemote('accounts', 'accounts');
  }, [state?.projectId, state?.posts, page, remote.accounts, remote.status?.zernio?.configured, remote.status?.zernio?.mapped]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); searchRef.current?.focus(); } };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dirtyScopes.current.clear(); setDraftDirty(false);
    if (!(discardPrompt && discardSwitch.current)) { setDiscardPrompt(false); discardAction.current = null; }
    const onSaved = (event: Event) => {
      const form = (event as CustomEvent).detail?.form;
      if (form instanceof HTMLFormElement && (dialog.contains(form) || dirtyScopes.current.has(form))) editorSaved(form);
    };
    dialog.addEventListener('campaign:editor-saved', onSaved);
    return () => dialog.removeEventListener('campaign:editor-saved', onSaved);
  }, [modal]);
  useEffect(() => {
    if (!(draftDirty && modal) && !inboxDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [draftDirty, modal, inboxDirty]);
  useEffect(() => {
    const onPop = () => {
      if (restoringPop.current) { const restored = restoringPop.current; restoringPop.current = null; restored(); return; }
      const next = readNavigation(window.location.search), targetIndex = Number.isSafeInteger(window.history.state?.campaignIndex) ? window.history.state.campaignIndex : historyIndex.current;
      const delta = targetIndex - historyIndex.current;
      if (state && next.projectId && !state.projects.some(project => project.id === next.projectId)) {
        if (delta) { restoringPop.current = () => setError('That project is unavailable.'); window.history.go(-delta); }
        else { writeNavigation(navigationRef.current, 'replace'); setError('That project is unavailable.'); }
        return;
      }
      const route = { ...next, projectId: next.projectId || state?.projectId || '' }, current = navigationRef.current;
      if ((modalRef.current && draftDirty || inboxDraft.current.dirty) && delta && (route.page !== current.page || route.section !== current.section || route.projectId !== current.projectId)) {
        restoringPop.current = () => leaveEditor(() => {
          restoringPop.current = () => { historyIndex.current = targetIndex; navigate(route, 'pop', delta, true); };
          window.history.go(delta);
        }, true);
        window.history.go(-delta); return;
      }
      historyIndex.current = targetIndex;
      navigate(route, 'pop', delta);
    };
    window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop);
  }, [state, draftDirty]);
  async function submitForm(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await saveEditor(Object.fromEntries(new FormData(e.currentTarget)));
  }
  async function saveEditor(values: Record<string, any>) {
    const requestProject = state!.projectId, requestModal = modal;
    const kind = modal!.type, editing = modal!.item;
    const result = await run(async () => {
      if (activeProject.current !== requestProject) throw new DOMException('Project changed', 'AbortError');

      if (kind === 'workspace') return api('/workspaces', 'POST', { name: values.name });
      if (kind === 'project') return api('/projects', 'POST', { ...values, workspaceId: workspace!.id });
      const collection = ({ campaign: 'campaigns', post: 'posts', placement: 'placements', asset: 'assets', provider: 'providers' } as Record<string, string>)[kind];
      for (const key of ['latitude', 'longitude']) if (key in values) values[key] = values[key] === '' ? null : Number(values[key]);
      for (const key of ['budget', 'spent', 'cost', 'impressions', 'clicks', 'conversions', 'inventory']) if (key in values) values[key] = Number(values[key]);
      if (kind === 'asset') values.tags = (values.tags || '').split(',').map((t: string) => t.trim()).filter(Boolean);
      return api(endpoint(collection + (editing ? '/' + editing.id : '')), editing ? 'PATCH' : 'POST', values);
    }, 'Saved successfully');
    if (result && activeProject.current === requestProject) {
      const current = modalRef.current === requestModal, nextProject = current ? result.projectId || result.project?.id || requestProject : requestProject;
      if (current) { modalRef.current = null; setModal(null); }
      if (nextProject !== requestProject) leaveEditor(() => { void run(() => reload(nextProject)); }, true);
      else await run(() => reload(nextProject));
    }
  }
  async function savePost(values: Record<string, any>, savedNotice = 'Post versions saved. Publishing is a separate action.') {
    const requestProject = state!.projectId, requestModal = modal, editing = modal?.item;
    if (activeProject.current !== requestProject) throw new DOMException('Project changed', 'AbortError');
    pendingWork.current++;
    setBusy(true); setError('');
    try {
      const result = await api(`/projects/${requestProject}/posts${editing ? '/' + editing.id : ''}`, editing ? 'PATCH' : 'POST', values);
      if (activeProject.current === requestProject) { if (modalRef.current === requestModal) setModal(null); setNotice(savedNotice); await reload(requestProject); }
      return result;
    } finally { setBusy(--pendingWork.current > 0); }
  }
  async function remove(collection: string, item: Row) {
    const requestProject = state!.projectId, requestModal = modal;
    await run(async () => { if (activeProject.current !== requestProject) throw new DOMException('Project changed', 'AbortError'); await api(endpoint(collection + '/' + item.id), 'DELETE'); if (activeProject.current === requestProject) { if (modalRef.current === requestModal) setModal(null); await reload(requestProject); } }, 'Record deleted');
  }
  async function clearSampleData() {
    const requestProject = state!.projectId;
    await run(async () => { const result = await api(`/projects/${requestProject}/sample-data`, 'DELETE'); if (activeProject.current === requestProject) { setRemote({}); await reload(requestProject); setNotice(`Removed ${result.removed} sample records.`); } });
  }
  async function uploadAsset(files: File[]) {
    const file = files[0]; if (!file) return;
    await run(async () => {
      if (file.size > 5 * 1024 * 1024) throw new Error('Choose a file of at most 5 MB.');
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('This file could not be read.')); reader.readAsDataURL(file); });
      await integrate('drive/upload', { name: file.name, mimeType: file.type, contentBase64: data }); await reload();
    }, 'Asset uploaded to Google Drive');
  }
  function changeAdStatus(c: Row) { run(async () => { const outcome = await integrate('ads/status', { campaignId: c.platformCampaignId || c.campaignId || c.id, platform: c.platform, status: c.status?.toLowerCase() === 'active' ? 'paused' : 'active' }); const read = ++adsRead.current, result = await integrate(adsPath(adsRange)); if (adsRead.current === read) setRemote((r: any) => ({ ...r, ads: result })); setNotice(outcome.verification === 'unavailable' ? 'Status request submitted. This network cannot confirm live delivery here; check the provider.' : 'Campaign status confirmed with provider'); }); }
  async function publish(post: Row) { await run(async () => { await integrate('social/publish', { postId: post.id }); await reload(); }, 'Submitted to Zernio. Check the post status for delivery.'); }
  // The composer's Schedule: save the post, then submit it through the post card's publish path (its step listed every destination).
  async function schedulePost(values: Record<string, any>) { const result = await savePost(values, ''); const post = result?.record || modal?.item; if (post?.id) await publish(post); return result; }
  async function loadRemote(key: string, path: string) { const id = state!.projectId; return run(async () => { const result = await integrate(path); if (activeProject.current === id) setRemote((r: any) => ({ ...r, [key]: result })); return result; }); }
  const [adsRange, setAdsRange] = useState('default'), [adsAccount, setAdsAccount] = useState(allAdAccounts), [hideAmounts, setHideAmounts] = useState(readHideAmounts), adsRead = useRef(0);
  const triggerRef = useRef<HTMLElement | null>(null), signedOutFocus = useRef(false);
  // Settings links stay real links; a plain click navigates in place through the editor guard.
  const settingsNavigate = useRef((_href: string) => {}); settingsNavigate.current = href => navigate(readNavigation(new URL(href, window.location.href).search));
  const SettingsLink = useMemo<NavLinkComponent>(() => function SettingsLink({ href, onClick, ...props }) { return <Link {...props} variant="quiet" href={href} onClick={event => { onClick?.(event); if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); settingsNavigate.current(href); }}/>; }, []);
  // A layout effect still sees the control that opened the editor; the dialog's own effect then moves focus inside it.
  useLayoutEffect(() => { triggerRef.current = modal && document.activeElement instanceof HTMLElement ? document.activeElement : null; }, [!!modal]);
  useEffect(() => { if (!session?.user) return; endSession = sessionExpired; return () => { endSession = null; }; }, [session]);
  useEffect(() => { if (session && !session.user && signedOutFocus.current) { signedOutFocus.current = false; document.querySelector<HTMLInputElement>('input[name="email"]')?.focus(); } }, [session]);
  // Declared after every other hook so hook-order test doubles keep their slots. Filters name this project's campaigns, so a project change clears them.
  const [calendarWeek, setCalendarWeek] = useState<string | undefined>(), [calendarFilters, setCalendarFilters] = useState<NonNullable<React.ComponentProps<typeof CampaignPublishingAgenda>['filters']>>({});
  useEffect(() => { setCalendarFilters({}); }, [state?.projectId]);
  async function loadAds(range = adsRange) { const id = state!.projectId, read = ++adsRead.current; return run(async () => { const result = await integrate(adsPath(range)); if (activeProject.current === id && adsRead.current === read) setRemote((r: any) => ({ ...r, ads: result })); }); }
  const adsFigure = (key: string, format: (value: number, row: Row) => string) => (row: Row) => { const value = campaignFigure(row, key); return value === undefined ? '—' : format(value, row); };
  const adsColumns = (rows: Row[]): DataColumn<Row>[] => [
    { key: 'name', header: 'Campaign', rowHeader: true, wrap: true, sortValue: c => c.name || c.campaignName || '', render: c => <Stack gap={1}><Text weight="semibold">{c.name || c.campaignName || 'Campaign'}</Text>{c.platformAdAccountName && <Text size="xs" tone="muted">{c.platformAdAccountName}</Text>}</Stack> },
    { key: 'platform', header: 'Network', sortValue: c => title(c.platform || c.network || ''), render: c => title(c.platform || c.network || '') },
    { key: 'status', header: 'Delivery', sortValue: c => c.status || '', render: c => <Stack gap={1}><Badge value={(c.status || 'unknown').toLowerCase()}/>{c.reviewStatus === 'in_review' && <Text size="xs" tone="muted">In platform review</Text>}</Stack> },
    ...([['adCount', 'Ads', compact], ['spend', 'Spend', (value: number, c: Row) => hideAmounts ? hiddenAmount : money(value, c.currency || c.metrics?.currency || 'USD')], ['impressions', 'Impressions', compact], ['clicks', 'Clicks', compact], ['ctr', 'CTR', (value: number) => `${value.toFixed(2)}%`], ['conversions', 'Conversions', compact], ['roas', 'ROAS', (value: number) => `${value.toFixed(2)}×`]] as [string, string, (value: number, row: Row) => string][]).map(([key, header, format]): DataColumn<Row> => ({ key, header, numeric: true, hidden: key !== 'spend' && key !== 'impressions' && !rows.some(c => campaignFigure(c, key) !== undefined), sortValue: c => campaignSortValue(c, key), render: adsFigure(key, format) }))
  ];
  async function createWorkspace(name: string) {
    if (pendingWork.current) return;
    await run(async () => { const result = await api('/workspaces', 'POST', { name }); await reload(result.projectId); });
  }
  function exportReport() {
    const rows = [['Campaign', 'Channel', 'Status', 'Currency', 'Budget', 'Spend', 'Impressions', 'Clicks', 'Conversions'], ...state!.campaigns.map(c => [c.name, c.channel, c.status, c.currency || 'AED', c.budget, c.spent, c.impressions, c.clicks, c.conversions])];
    const csv = rows.map(row => row.map(cell => { let v = String(cell ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return '"' + v.replaceAll('"', '""') + '"'; }).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' })); const a = document.createElement('a'); a.href = url; a.download = 'ten98-campaign-report.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  // Any member may leave; an owner only while another owner remains (the server refuses the last owner). The app then reloads its workspaces.
  async function leaveWorkspace() {
    const workspaceId = workspace!.id, userId = state!.user.id;
    await run(async () => { await api(`/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`, 'DELETE'); window.location.reload(); });
  }
  if (!session) return <AppStateScreen surface="card" state={error ? 'error' : 'loading'} brand={<Brand product="Campaign"/>} message={error || 'Loading Campaign…'}/>;
  if (inviteToken && !(inviteSignIn && !session.user)) return <AcceptInvitation key={inviteToken + ':' + (session.user?.id || '')} token={inviteToken} signedInEmail={session.user?.email} request={api} onAccepted={() => { window.location.assign('/'); }} onSignIn={email => { setInviteSignIn({ email }); if (session.user) run(async () => { await api('/auth/logout', 'POST', {}); setSession(await api('/session')); }); }}/>;
  if (!session.user) return <Auth session={session} inviteToken={inviteToken} inviteEmail={inviteSignIn?.email} onBackToInvitation={() => { setError(''); setInviteSignIn(null); }} error={error} busy={busy} onOidcStart={() => run(async () => {
    const { authorizationUrl } = await api('/auth/oidc/start', 'POST', { token: inviteToken });
    if (typeof authorizationUrl !== 'string' || !/^https?:\/\//.test(authorizationUrl)) throw new Error('Single sign-on could not be started. Try again.');
    window.location.assign(authorizationUrl);
  })} onSubmit={async values => { rememberFocus(); await run(async () => { await api('/auth/' + (session.setupRequired ? 'setup' : 'login'), 'POST', values); const s = await api('/session'); ++loadVersion.current; activeProject.current = ''; pendingKeys.current.clear(); setState(null); setRemote({}); setSession(s); await reload(new URLSearchParams(window.location.search).get('project') || ''); }); }}/>;
  if (!state) return <AppStateScreen surface="card" state={error ? 'error' : 'loading'} brand={<Brand product="Campaign"/>} message={error || 'Loading your campaigns…'} onRetry={error ? () => run(() => reload()) : undefined}/>;
  if (!state.projectId || !project) return <WorkspaceOnboarding brand={<Brand product="Campaign" href="/"/>} label="Workspace access" email={state.user.email} subheading="No project access yet." help="Ask a workspace owner for an invitation, refresh after access is granted, or create your own workspace." error={error || undefined} busy={busy} onSubmit={({ name }) => createWorkspace(name)} onRefresh={() => run(() => reload(''))} signOut={{ onClick: signOut }}><AccountSettings request={api} onChanged={() => { run(() => reload('')); }}/></WorkspaceOnboarding>;
  const campaigns = filtered(state.campaigns).filter(c => tab === 'all' || c.status === tab);
  const currencyCampaigns = state.campaigns.filter(c => (c.currency || 'AED') === currency);
  const currentCurrency = currencyCampaigns.filter(c => c.budgetType !== 'daily');
  const spent = currencyCampaigns.every(c => numeric(c.spent)) ? currencyCampaigns.reduce((sum, c) => sum + c.spent, 0) : undefined, budget = currentCurrency.reduce((sum, c) => sum + Number(c.budget || 0), 0);
  const impressions = state.campaigns.every(c => numeric(c.impressions)) ? state.campaigns.reduce((sum, c) => sum + c.impressions, 0) : undefined;
  const spendCaption = currencyCampaigns.some(c => c.budgetType === 'daily') ? `${money(budget, currency)} total allocation · daily budgets separate` : numeric(spent) && budget > 0 ? `${Math.round(spent / budget * 100)}% of ${money(budget, currency)} total budget` : `${money(budget, currency)} total budget`;
  const activeCampaigns = state.campaigns.filter(c => c.status === 'active').length;
  const calendarPosts = state.posts.flatMap(post => postScheduleEntries(post, remote.accounts?.accounts || []));
  const calendarOverlay = calendarOverlayEvents(calendarEvents, calendarPosts, state.projectId);
  const visiblePosts = filtered(state.posts).filter(post => tab === 'all' || post.status === tab);
  const visibleAssets = filtered(state.assets).filter(asset => tab === 'all' || asset.kind === tab);
  const approvalsBadge = approvalBadge(approvalSummary);
  const searchable = !(page === 'Ads manager' && adsView !== 'campaigns') && !(page === 'Publishing' && ['queues', 'destinations'].includes(publishingView)) && ['Overview', 'Campaigns', 'Publishing', 'Ads manager', 'OOH media', 'Asset library', 'Media providers', 'Analytics'].includes(page);
  const actionKind: Partial<Record<Page, string>> = { Campaigns: 'campaign', Publishing: 'post', Calendar: 'post', 'OOH media': 'placement', 'Asset library': 'asset', 'Media providers': 'provider' };
  const actionText: Partial<Record<Page, string>> = { Campaigns: 'New campaign', Publishing: 'Create post', Calendar: 'Create post', 'OOH media': 'Book placement', 'Asset library': 'Add asset', 'Media providers': 'Add provider' };
  function openCampaign(campaign: Row) {
    if (campaign.nativeProvider) setPage('Ads manager', campaign.nativeProvider === 'googleAdsNative' ? 'shopping' : 'microsoft');
    else setModal({ type: 'campaign', item: campaign });
  }
  const campaignTable = (rows: Row[], overview = false) => <DataTable ariaLabel={overview ? 'Recent campaigns' : 'Campaigns'} searchable={false} sortable={false} pagination={false} rows={rows} rowKey={c => c.id} columns={[
    { key: 'name', header: 'Campaign', rowHeader: true, wrap: true, render: c => <Stack gap={0}><Text weight="semibold">{c.name}</Text><Text as="small" size="sm" tone="muted">{date(c.startDate)} – {date(c.endDate)}</Text></Stack> },
    { key: 'status', header: 'Status', render: c => <Badge value={c.status}/> },
    { key: 'channel', header: 'Channel', render: c => channels[c.channel] || c.channel },
    { key: 'budget', header: 'Budget / spend', render: c => { const used = budgetProgress(c.spent, c.budget); return <Stack gap={1}><Text>{money(c.spent, c.currency || 'AED')} / {money(c.budget, c.currency || 'AED')}{c.budgetType === 'daily' ? ' / day' : ''}</Text><Meter value={used} label={'Budget used by ' + c.name} valueLabel={Math.round(used) + '%'}/></Stack>; } },
    { key: 'impressions', header: 'Impressions', numeric: true, hidden: overview, render: c => compact(c.impressions) },
  ]} rowActionsLabel="Actions" rowActions={c => <Button variant="ghost" size="sm" aria-label={(c.nativeProvider || c.externalId || !canWrite ? 'View ' : 'Edit ') + c.name} onClick={() => openCampaign(c)}>{c.nativeProvider || c.externalId || !canWrite ? 'View' : 'Edit'}</Button>} emptyState={<EmptyState title="No campaigns" description="Create a campaign to track its dates, budget and results." action={canWrite ? <Button variant="primary" onClick={() => setModal({ type: 'campaign' })}>New campaign</Button> : undefined}/>}/>;
  const connected = remote.status?.zernio?.configured && remote.status?.zernio?.mapped;
  // Home: campaigns are the core object, so active ones come first; setup steps count only the team's own records.
  const activeRows = filtered(state.campaigns).filter(c => c.status === 'active');
  const setupSteps: SetupStep[] = [
    { id: 'accounts', title: 'Connect your social and ad accounts', detail: canAdmin ? 'Publish posts and run ads from one place.' : 'An owner or administrator connects accounts in Settings › Connections.', done: !!state.connections.zernio, action: 'Connect accounts', onAction: () => setPage('Integrations') },
    { id: 'campaign', title: 'Create your first campaign', detail: 'A campaign keeps posts, ads, messages and billboards for one launch together.', done: state.campaigns.some(c => !c.sample), action: 'New campaign', onAction: () => setModal({ type: 'campaign' }) },
    { id: 'post', title: 'Schedule your first post', detail: 'Write it once and choose where and when it goes out.', done: state.posts.some(p => !p.sample && ['scheduled', 'submitted', 'published'].includes(p.status)), action: 'Create post', onAction: () => setModal({ type: 'post' }) },
    { id: 'drive', title: 'Connect Google Drive for your media', detail: 'Use the photos and videos your team already keeps in Drive.', done: !!state.connections.drive, action: 'Connect Drive', onAction: () => setPage('Integrations') },
  ];
  // The same gates as the post card's publish button; the server still decides.
  const composerApproval = modal?.type === 'post' ? approvalGate(approvalSummary, modal.item?.id || '') : null;
  const composerPublishBlock = !connected ? 'Connect Zernio in Integrations to publish.' : modal?.item?.sample ? 'Sample posts cannot be published.' : composerApproval && !composerApproval.publishable ? composerApproval.reason : undefined;
  const driveSyncReason = !canWrite ? 'Viewers can review assets but not sync Drive.' : !remote.status?.drive ? '' : !remote.status.drive.configured ? 'Configure Google Drive in Integrations to sync files.' : !remote.status.drive.mapped ? 'Map a Drive folder to this project in Integrations to sync files.' : '';
  // Sub-view tabs are links to the section's own URL; a plain click navigates in place through the editor guard.
  const sections = (label: string, current: string, entries: string[][], select: (value: string) => void) => <SectionNav label={label} items={entries.map(([id, text]) => ({ id, label: text, current: current === id, href: navigationUrl({ page, section: id, projectId: state.projectId || '' }, window.location.href) }))} onSelect={(item, event) => { event.preventDefault(); select(item.id); }}/>;
  const area = areaOf(page, section), areaCurrent = areaTab(page, section);
  const settingsUrl = (next: string) => navigationUrl({ page: 'Settings', section: next, projectId: state.projectId || '' }, window.location.href);
  const settingsItems: SettingsNavItem[] = [
    { id: 'general', label: 'General', group: 'project', icon: 'settings', href: settingsUrl('general') }, { id: 'approvals', label: 'Approvals', group: 'project', icon: 'check', href: settingsUrl('approvals') },
    { id: 'queues', label: 'Posting times', group: 'project', icon: 'clock', href: navigationUrl({ page: 'Publishing', section: 'queues', projectId: state.projectId || '' }, window.location.href) }, { id: 'destinations', label: 'Publishing defaults', group: 'project', icon: 'send', href: navigationUrl({ page: 'Publishing', section: 'destinations', projectId: state.projectId || '' }, window.location.href) }, { id: 'activity', label: 'Activity', group: 'project', icon: 'activity', href: settingsUrl('activity') },
    { id: 'members', label: 'Members', group: 'workspace', icon: 'users', href: settingsUrl('members') }, { id: 'connections', label: 'Connections', group: 'workspace', icon: 'workflow', href: navigationUrl({ page: 'Integrations', section: '', projectId: state.projectId || '' }, window.location.href) },
    { id: 'profile', label: 'Profile', group: 'account', icon: 'user', href: settingsUrl('profile') }, { id: 'security', label: 'Security', group: 'account', icon: 'shield', href: settingsUrl('security') },
    { id: 'sign-in', label: 'Sign-in', group: 'operator', icon: 'server', href: settingsUrl('sign-in'), allowed: !!state.user.isOperator },
  ];
  const settingsFrame = (content: React.ReactNode) => <SettingsLayout title="Settings" scope={project?.name} navigationLabel="Settings sections" groupLabels={{ operator: 'Advanced' }} items={settingsItems} current={page === 'Integrations' ? 'connections' : section} linkComponent={SettingsLink}>{content}</SettingsLayout>;
  const tabUrl = (tab: AreaTab) => navigationUrl({ page: tab.page, section: tab.sections?.[0] || pageSections[tab.page]?.[0] || '', projectId: state.projectId || '' }, window.location.href);
  const tabBadge = (tab: AreaTab) => tab.page === 'Approvals' && approvalsBadge ? approvalsBadge.count : undefined;
  const areaItem = (entry: Area): SidebarNavItem => ({ id: entry.id, label: entry.label, icon: entry.icon, current: entry === area, ...(entry.id === 'planner' && approvalsBadge ? { badge: approvalsBadge.count, badgeLabel: approvalsBadge.label } : {}), href: tabUrl(entry.tabs[0]), onSelect: (_item, event) => { event.preventDefault(); setPage(entry.tabs[0].page, entry.tabs[0].sections?.[0]); } });
  return <>
    <AppShell sidebarLabel="Campaign navigation" mainLabel={area.label} skipLinkLabel="Skip to content" navigation={{ open: mobile, onOpenChange: setMobile }}
      sidebar={<>
        <Brand product="Campaign" href="#" onClick={e => { e.preventDefault(); setPage('Overview'); }}/>
        <WorkspaceProjectSwitcher workspaces={state.workspaces.map(w => ({ id: w.id, name: w.name, roleLabel: title(w.role || 'member') + ' workspace', initials: initial(w.name) }))} projects={state.projects.filter(p => p.workspaceId === workspace?.id).map(p => ({ id: p.id, name: p.name }))} workspaceId={workspace?.id || null} projectId={state.projectId} onWorkspaceChange={id => { const p = state.projects.find(p => p.workspaceId === id); if (p) changeProject(p.id); }} onProjectChange={changeProject} create={canWrite ? { label: 'Create project', onSelect: () => setModal({ type: 'project' }) } : undefined}/>
        <SidebarNav label="Main navigation" groups={[{ id: 'main', items: areas.filter(entry => entry.id !== 'settings').map(areaItem) }, { id: 'settings', items: [areaItem(areas.at(-1)!)] }]}/>
        <SidebarStatus tone={connected ? 'connected' : 'idle'} label={connected ? 'Accounts connected' : 'Connect your accounts'} action={{ label: 'Connections', onSelect: () => setPage('Integrations') }}/>
      </>}
      topbar={<AppTopbar menuToggle menuLabel="Open navigation" breadcrumb={{ scope: project?.name, current: area.label }} search={searchable ? <SearchField variant="topbar" label={'Search ' + areaCurrent.label} hideLabel placeholder="Search this view…" value={query} onValueChange={setQuery} shortcut={searchShortcut} inputRef={searchRef}/> : undefined}
        actions={<AccountMenu name={state.user.name} email={state.user.email} items={[{ id: 'settings', kind: 'button', label: 'Settings', icon: 'settings', onSelect: () => setPage('Settings') }, { id: 'separator', kind: 'separator' }, { id: 'sign-out', kind: 'button', label: 'Sign out', danger: true, onSelect: signOut }]}/>}/>}>
        {area.id !== 'settings' && <PageHeader title={area.label} actions={page === 'Overview' || page === 'Analytics' && insightsView === 'summary' ? <Inline><Button variant="secondary" icon={<Icon name="download" size={16}/>} onClick={exportReport}>Export report</Button>{canWrite && page === 'Overview' && <Button variant="primary" icon={<Icon name="plus" size={17}/>} onClick={() => setModal({ type: 'campaign' })}>New campaign</Button>}</Inline> : actionKind[page] && canWrite && !(page === 'Publishing' && publishingView === 'library') ? <Button variant="primary" icon={<Icon name="plus" size={17}/>} onClick={() => setModal({ type: actionKind[page]! })}>{actionText[page]}</Button> : page === 'Ads manager' && adsView === 'campaigns' && canWrite ? <Button variant="primary" icon={<Icon name="plus" size={17}/>} disabled={!connected || busy} onClick={() => setModal({ type: 'ad' })}>Create ad</Button> : undefined}/>}
        {error && <Alert tone="danger" onDismiss={() => setError('')} dismissLabel="Dismiss error">{error}</Alert>}
        {spendBlock && <AdSpendNotice block={spendBlock} onOpenApprovals={() => { setSpendBlock(null); setPage('Approvals'); }} onDismiss={() => setSpendBlock(null)}/>}
        {sample && area.id !== 'settings' && <Alert tone="info" variant="banner" title="Sample workspace" actions={canWrite ? <Button variant="secondary" size="sm" onClick={() => setModal({ type: 'project' })}>Create project</Button> : undefined}>This project contains sample records.</Alert>}
        {loading && <Progress label="Loading project data"/>}
        {area.tabs.length > 1 && area.id !== 'settings' && <SectionNav label={area.label + ' sections'} items={area.tabs.map(tab => ({ id: area.tabs.indexOf(tab).toString(), label: tab.label, current: tab === areaCurrent, href: tabUrl(tab), badge: tabBadge(tab) }))} onSelect={(item, event) => { event.preventDefault(); const tab = area.tabs[Number(item.id)]; setPage(tab.page, tab.sections?.[0]); }}/>}
        {page === 'Overview' && canWrite && <HomeSetup key={state.projectId} projectId={state.projectId} steps={setupSteps}/>}
        {page === 'Overview' && <Card as="section" headingLevel={2} title={activeRows.length ? 'Active campaigns' : 'Campaigns'} actions={<Button variant="ghost" onClick={() => setPage('Campaigns')}>View all campaigns</Button>}>{campaignTable(activeRows.length ? activeRows.slice(0, 5) : filtered(state.campaigns).slice(0, 5), true)}</Card>}
        {(page === 'Overview' || page === 'Analytics' && insightsView === 'summary') && <>
          <Inline justify="between" align="center"><Text><Text as="strong">{plural(activeCampaigns, 'active campaign')}</Text> <Text as="span" tone="muted">across your project</Text></Text><UiSelect width="auto" aria-label="Reporting currency" value={currency} onChange={event => setCurrency(event.currentTarget.value)} options={['AED', 'USD', 'EUR', 'GBP'].map(value => ({ value, label: 'Reporting in ' + value }))}/></Inline>
          <Grid columns={4}><Stat label="Campaign spend" value={money(spent, currency)} caption={spendCaption} icon="money"/><Stat label="Total impressions" value={compact(impressions)} caption="Across tracked campaigns" icon="eye"/><Stat label="Scheduled posts" value={String(state.posts.filter(p => p.status === 'scheduled').length)} caption={plural(state.posts.filter(p => p.status === 'draft').length, 'draft')} icon="calendar"/><Stat label="OOH placements" value={String(state.placements.filter(p => ['live', 'booked'].includes(p.status)).length)} caption={plural(state.providers.length, 'media provider')} icon="billboard"/></Grid>
          <Grid columns={2}><Card as="section" headingLevel={2} title="Campaign performance" description={'Spend against budget, by campaign · ' + currency}><Stack gap={3}><BarList label={'Spend against budget in ' + currency} items={currentCurrency.slice(0, 5).map(c => ({ id: c.id, label: c.name, value: numeric(c.spent) ? c.spent : null, valueText: money(c.spent, currency) + ' of ' + money(c.budget, currency), share: budgetProgress(c.spent, c.budget) / 100 }))} emptyMessage={'Add a campaign in ' + currency + ' to start tracking performance.'}/><Text tone="muted" size="sm">{sample ? 'Illustrative data' : 'Locally tracked campaign totals'} · Provider insights are in Ads manager.</Text></Stack></Card><Card as="section" headingLevel={2} title="Campaigns by channel" actions={<Button variant="ghost" onClick={() => setPage('Campaigns')}>View campaigns</Button>}><ProportionBar label={`${plural(state.campaigns.length, 'campaign')} in this project`} total={state.campaigns.length} formatCount={count => plural(count, 'campaign')} emptyMessage="Your channels will appear here." segments={Object.entries(channels).map(([id, label], index) => ({ id, label, count: state.campaigns.filter(c => c.channel === id).length, tone: (index + 1) as 1 | 2 | 3 | 4 }))}/></Card></Grid>
          {page === 'Overview' ? <><Grid columns={2}><Card as="section" headingLevel={2} title="Up next" actions={<Button variant="ghost" onClick={() => setPage('Calendar')}>Open calendar</Button>}><SelectableList label="Upcoming posts" onSelect={id => { const next = upcomingPosts(state.posts, Date.now(), remote.accounts?.accounts || []).find(p => p.id === id); if (next) setModal({ type: 'post', item: next.post }); }} emptyMessage="No upcoming posts. Create a post and choose a date to fill your calendar." items={upcomingPosts(state.posts, Date.now(), remote.accounts?.accounts || []).slice(0, 3).map(p => ({ id: p.id, title: (p.content || (p.accountId ? 'Selected account post' : postLabel(p.post))).slice(0, 65), preview: (p.platform ? title(p.platform) : 'Selected account') + (p.accountId ? ' · ' + (remote.accounts?.accounts?.find((account: Row) => String(account._id || account.id) === p.accountId)?.displayName || p.accountId) : ''), meta: new Date(p.scheduledAt).toLocaleDateString('en', { day: 'numeric', month: 'short' }), status: p.post.externalId ? 'Submitted' : 'Planned' }))}/></Card><Card as="section" headingLevel={2} title="Workspace activity">{state.activity.length ? <ActivityFeed items={state.activity.slice(0, 4).map(a => ({ id: a.id, title: a.message || a.action || a.description, time: date(a.createdAt), icon: 'check', tone: 'success' }))}/> : <EmptyState title="No activity" description="Saved changes and provider actions appear here."/>}</Card></Grid></> : <Card as="section" headingLevel={2} title="Campaign results" description="Local campaign totals. Live network insights are available in Ads manager."><DataTable ariaLabel="Campaign results" searchable={false} pagination={false} rows={filtered(state.campaigns)} rowKey={c => c.id} emptyTitle={state.campaigns.length ? 'No campaigns match this search' : 'No campaign results yet'} emptyDescription={state.campaigns.length ? 'Try another campaign name or channel.' : 'Create a campaign and record its impressions, clicks and conversions to compare results here.'} columns={[{ key: 'name', header: 'Campaign', rowHeader: true, render: c => c.name }, { key: 'impressions', header: 'Impressions', numeric: true, render: c => numeric(c.impressions) ? compact(c.impressions) : '—' }, { key: 'clicks', header: 'Clicks', numeric: true, render: c => numeric(c.clicks) ? compact(c.clicks) : '—' }, { key: 'ctr', header: 'CTR', numeric: true, render: c => numeric(c.impressions) && c.impressions > 0 && numeric(c.clicks) ? (c.clicks / c.impressions * 100).toFixed(2) + '%' : '—' }, { key: 'conversions', header: 'Conversions', numeric: true, render: c => numeric(c.conversions) ? c.conversions : '—' }, { key: 'cost', header: 'Cost per conversion', numeric: true, render: c => numeric(c.conversions) && c.conversions > 0 && numeric(c.spent) ? money(c.spent / c.conversions, c.currency || 'AED') : '—' }]}/></Card>}
        </>}
        {page === 'Approvals' && <ContentApprovals key={state.projectId + ':' + state.user.id} projectId={state.projectId} role={workspace?.role || 'viewer'} currentUserId={state.user.id} request={api} onOpenSettings={() => setPage('Settings', 'approvals')} onChanged={() => { if (activeProject.current === state.projectId) return reload(); }}/> }
        {page === 'Draft content' && <CampaignAgent key={state.projectId} projectId={state.projectId} onOpenIntegrations={() => setPage('Integrations')} canWrite={canWrite} request={api} onOpenAdDraft={draft => { if (activeProject.current !== state.projectId) return; setPage('Ads manager', 'campaigns'); setModal({ type: 'ad', item: { ...draft, id: 'ai-ad-draft' } }); }} onSaved={() => { if (activeProject.current === state.projectId) { run(() => reload()); setNotice('Draft saved in this project.'); } }}/>}
        {page === 'Analytics' && <>{insightsView === 'summary' ? <SocialAnalytics key={state.projectId} request={integrate} connected={!!connected}/> : connected ? <Suspense fallback={<StatusLine busy>Loading account reports…</StatusLine>}><ZernioInsights key={state.projectId} projectId={state.projectId} request={api}/></Suspense> : <ConnectionEmpty onSettings={() => setPage('Integrations')} subject="social account reports"/>}</>}
        {page === 'Links & tracking' && <Suspense fallback={<StatusLine busy>Loading campaign links…</StatusLine>}><CampaignLinks key={state.projectId} projectId={state.projectId} campaigns={state.campaigns} readOnly={!canWrite} canManageSettings={canAdmin} canChangeDomain={canMap} request={async (path, method, body, key) => { const id = state.projectId; if (activeProject.current !== id) throw new DOMException('Project changed.', 'AbortError'); const result = await api(path, method, body, key); if (activeProject.current !== id) throw new DOMException('Project changed.', 'AbortError'); return result; }}/></Suspense>}
        {page === 'Unified inbox' && <Suspense fallback={<StatusLine busy>Loading inbox…</StatusLine>}><UnifiedInbox onOpenIntegrations={() => setPage('Integrations')} key={state.projectId} projectId={state.projectId} readOnly={!canWrite} role={workspace?.role || 'viewer'} onDraftChange={inboxDraftChanged} initialChannel={inboxTarget?.projectId === state.projectId ? inboxTarget.channel : undefined} initialAccountId={inboxTarget?.projectId === state.projectId ? inboxTarget.accountId : undefined} initialSearch={inboxTarget?.projectId === state.projectId ? inboxTarget.search : undefined} request={async (path, method, body, key) => { const id = state.projectId; if (activeProject.current !== id) throw new DOMException('Project changed.', 'AbortError'); const result = await api(path, method, body, key); if (activeProject.current !== id) throw new DOMException('Project changed.', 'AbortError'); return result; }}/></Suspense>}
        {page === 'Direct campaigns' && directView === 'templates' && (connected ? <Suspense fallback={<StatusLine busy>Loading WhatsApp templates…</StatusLine>}><ZernioWhatsAppTemplates key={state.projectId} projectId={state.projectId} canManage={canAdmin} isOperator={canMap} request={api}/></Suspense> : <ConnectionEmpty onSettings={() => setPage('Integrations')} subject="WhatsApp templates"/>)}{page === 'Direct campaigns' && directView === 'contacts' && (connected ? <Suspense fallback={<StatusLine busy>Loading connected contacts…</StatusLine>}><ZernioContacts key={state.projectId} projectId={state.projectId} canManage={canAdmin} canWrite={canWrite} isOperator={canMap} request={api} onChanged={() => reload()}/></Suspense> : <ConnectionEmpty onSettings={() => setPage('Integrations')} subject="social contacts"/>)}{page === 'Direct campaigns' && ['people', 'contacts'].includes(directView) && <SegmentedControl label="Contacts to show" value={directView} onValueChange={next => setPage('Direct campaigns', next)} options={[{ value: 'people', label: 'Your contacts' }, { value: 'contacts', label: 'From social accounts' }]}/>}
        {page === 'Direct campaigns' && ['campaigns', 'people'].includes(directView) && <Suspense fallback={<StatusLine busy>Loading campaigns…</StatusLine>}><DirectCampaigns key={state.projectId} projectId={state.projectId} view={directView === 'people' ? 'contacts' : 'campaigns'} isOperator={canMap} onOpenIntegrations={() => setPage('Integrations')} onShortenText={async (text, campaignId) => (await shortenPostLinks({ content: text, campaignId })).content} readOnly={!canWrite} onOpenReplies={(channel, accountId, phone) => { setInboxTarget({ channel, accountId, search: phone, projectId: project.id }); setPage('Unified inbox'); }} request={async (path, method, body) => { const id = state.projectId; if (activeProject.current !== id) throw new DOMException('Project changed.', 'AbortError'); const result = await api(path, method, body); if (activeProject.current !== id) throw new DOMException('Project changed.', 'AbortError'); return result; }}/></Suspense>}
        {page === 'Campaigns' && <Card as="section"><Stack gap={3}><Inline justify="between" align="center"><SegmentedControl label="Campaign status" value={tab} onValueChange={setTab} options={['all', 'active', 'draft', 'paused', 'completed'].map(t => ({ value: t, label: (t === 'all' ? 'All campaigns' : title(t)) + ' · ' + state.campaigns.filter(c => t === 'all' || c.status === t).length }))}/><Text tone="muted" size="sm">{plural(campaigns.length, 'campaign')}</Text></Inline>{campaignTable(campaigns)}</Stack></Card>}
        {page === 'Publishing' && publishingView === 'library' && (connected ? <Suspense fallback={<StatusLine busy>Loading post library…</StatusLine>}><ZernioPostLibrary key={state.projectId} projectId={state.projectId} canWrite={canWrite} campaigns={state.campaigns} request={api}/><ZernioBlogDrafts key={state.projectId + ':blogs'} canWrite={canWrite} request={integrate} onCreate={canWrite ? selection => setModal({ type: 'blog-draft', item: { id: selection.account.id + ':' + selection.blog.id, ...selection } }) : undefined} onEditDraft={canWrite ? (account, blog, article) => setModal({ type: 'blog-draft', item: { id: account.id + ':' + blog.id + ':' + article.id, account, blog, article } }) : undefined}/><ZernioProducts key={state.projectId + ':products'} request={integrate} onRenameCollection={canWrite ? (account, store, collection) => setModal({ type: 'collection-title', item: { id: account.id + ':' + collection.id, account, store, collection } }) : undefined} onDeactivate={canWrite ? (account, store, product) => setModal({ type: 'product-state', item: { id: account.id + ':' + product.id, account, store, product } }) : undefined} onArchive={canWrite ? (account, store, product) => setModal({ type: 'product-state', item: { id: account.id + ':' + product.id, account, store, product, stateAction: 'archive' } }) : undefined} onActivate={canWrite ? (account, store, product) => setModal({ type: 'product-state', item: { id: account.id + ':' + product.id, account, store, product, stateAction: 'activate' } }) : undefined} onDeleteProduct={canWrite ? (account, store, product) => setModal({ type: 'product-state', item: { id: account.id + ':' + product.id, account, store, product, stateAction: 'delete' } }) : undefined} onPrice={canWrite ? (account, store, product) => setModal({ type: 'product-price', item: { id: account.id + ':' + product.id, account, store, product } }) : undefined} onCreate={canWrite ? (account, store) => setModal({ type: 'product-create', item: { id: account.id, account, store } }) : undefined} onEdit={canWrite ? (account, store, product) => setModal({ type: 'product-edit', item: { id: account.id + ':' + product.id, account, store, product } }) : undefined}/></Suspense> : <ConnectionEmpty onSettings={() => setPage('Integrations')} subject="imported posts"/>)}{page === 'Publishing' && publishingView === 'queues' && settingsFrame(connected ? <Suspense fallback={<StatusLine busy>Loading publishing queues…</StatusLine>}><ZernioQueues key={state.projectId} projectId={state.projectId} canManage={canAdmin} canWrite={canWrite} request={api} onChanged={() => { if (activeProject.current === state.projectId) return reload(); }} onEditPost={id => { const post = state.posts.find(item => item.id === id); if (post) setModal({ type: 'post', item: post }); }} onOpenApprovals={() => setPage('Approvals')}/></Suspense> : <ConnectionEmpty onSettings={() => setPage('Integrations')} subject="posting times"/>)}{page === 'Publishing' && publishingView === 'destinations' && settingsFrame(connected ? <Suspense fallback={<StatusLine busy>Loading publishing destinations…</StatusLine>}><ZernioDestinations key={state.projectId} projectId={state.projectId} canManage={canAdmin} request={api}/></Suspense> : <ConnectionEmpty onSettings={() => setPage('Integrations')} subject="board and playlist defaults"/>)}{page === 'Publishing' && publishingView === 'recycling' && <Inline><Button variant="ghost" icon={<Icon name="chevron-left" size={15}/>} onClick={() => setPublishingView('posts')}>All posts</Button></Inline>}{page === 'Publishing' && publishingView === 'recycling' && (connected ? <Suspense fallback={<StatusLine busy>Loading recurring posts…</StatusLine>}><ZernioRecycling key={state.projectId} projectId={state.projectId} canManage={canAdmin} request={api} onChanged={() => { if (activeProject.current === state.projectId) return reload(); }}/></Suspense> : <ConnectionEmpty onSettings={() => setPage('Integrations')} subject="repeating posts"/>)}{page === 'Publishing' && publishingView === 'posts' && <><Inline justify="between" align="center"><SegmentedControl label="Post status" value={tab} onValueChange={setTab} options={['all', 'draft', 'scheduled', 'published', 'failed', 'cancelled'].map(t => ({ value: t, label: t === 'all' ? 'All posts' : title(t) }))}/><Inline gap={2}><Button variant="ghost" onClick={() => setPublishingView('recycling')}>Repeating posts</Button>{!connected && <Text tone="muted" size="sm">Connect Zernio in Integrations to load channels.</Text>}<Button variant="secondary" icon={<Icon name="refresh" size={15}/>} disabled={busy || !connected} onClick={() => loadRemote('accounts', 'accounts')}>Load channels</Button></Inline></Inline><Grid columns="auto" minItemWidth="md">{visiblePosts.map(p => { const approval = approvalGate(approvalSummary, p.id); return <Card as="article" key={p.id} headingLevel={3} title={p.platforms?.length ? p.platforms.map((name: string) => title(name)).join(' · ') : 'Social post'} actions={<Badge value={p.status === 'scheduled' && !p.externalId ? 'planned' : p.status}/>}><Stack gap={2}>{p.assetId && state.assets.find(a => a.id === p.assetId) && <Creative item={state.assets.find(a => a.id === p.assetId)!} small/>}<Text>{postLabel(p)}</Text><Text tone="muted" size="sm">Recipients: {postRecipients(p, remote.accounts?.accounts || [])}</Text><Inline gap={2} align="center"><Text tone="muted" size="sm">{p.publishedAt ? 'Published ' + date(p.publishedAt) : p.status === 'published' ? 'Published · time not reported' : p.queueId ? 'Queue selected · review before adding' : p.scheduledAt ? new Date(p.scheduledAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Unscheduled draft'}</Text>{approval && <UiBadge tone={approval.status === 'approved' ? 'success' : ['rejected', 'stale'].includes(approval.status) ? 'danger' : 'warning'}>{approval.label}</UiBadge>}{p.sample && <UiBadge>Sample</UiBadge>}{Object.keys(p.platformOverrides || {}).length > 0 && <UiBadge>Platform customizations</UiBadge>}{Object.keys(p.accountOverrides || {}).length > 0 && <UiBadge>Account customizations</UiBadge>}</Inline>{approval && !approval.publishable && !p.externalId && <Text tone="muted" size="sm">{approval.reason}</Text>}{canWrite && !p.sample && !p.externalId && (!approval || approval.publishable) && !connected && <Text tone="muted" size="sm">Connect Zernio in Integrations to publish this post.</Text>}<FormActions><Button variant="secondary" onClick={() => setModal({ type: 'post', item: p })}>{canWrite && !p.externalId && p.status !== 'published' ? 'Edit post' : 'View post'}</Button>{canWrite && !p.sample && !p.externalId && (!approval || approval.publishable ? <Button variant="primary" icon={<Icon name="send" size={14}/>} disabled={busy || !connected} onClick={() => setPublishing(p)}>{p.queueId ? 'Add to queue' : p.status === 'scheduled' ? 'Schedule' : 'Publish'}</Button> : <Button variant="secondary" onClick={() => setPage('Approvals')}>Open approvals</Button>)}{p.externalId && <Button variant="secondary" disabled={busy} onClick={() => run(async () => { await integrate('social/status?postId=' + p.id); await reload(); }, 'Post status refreshed')}>Check status</Button>}</FormActions></Stack></Card>; })}</Grid>{!visiblePosts.length && <EmptyState icon="send" title={state.posts.length ? "No posts in this view" : "No posts"} description={state.posts.length ? "Try another status or search, or create a new draft." : "Draft content, attach an asset, and publish across your connected channels."}/>}</>}
        {page === 'Calendar' && <GoogleCalendar key={state.projectId} projectId={state.projectId} onOpenIntegrations={() => setPage('Integrations')} canWrite={canWrite} request={api} fromDate={`${calendar.getFullYear()}-${String(calendar.getMonth() + 1).padStart(2, '0')}-01`} toDate={`${calendar.getFullYear()}-${String(calendar.getMonth() + 1).padStart(2, '0')}-${new Date(calendar.getFullYear(), calendar.getMonth() + 1, 0).getDate()}`} onEvents={events => { if (activeProject.current === state.projectId) setCalendarEvents(events); }} agenda={eventActions => <Suspense fallback={<Stack gap={2} role="status" aria-label="Loading publishing agenda"><Skeleton/><Skeleton/><Skeleton/></Stack>}><CampaignPublishingAgenda posts={calendarPosts} googleEvents={calendarOverlay} activations={state.activations || []} records={state.posts} month={calendar} accounts={remote.accounts?.accounts || []} campaigns={state.campaigns} canWrite={canWrite} postApprovals={approvalSummary?.requireApproval ? Object.fromEntries(Object.keys(approvalSummary.statuses).map(id => [id, approvalGate(approvalSummary, id)!.label])) : undefined} postLabel={postLabel} onSelect={post => setModal({ type: 'post', item: post })} googleEventActions={eventActions} actions={<Inline><Button variant="secondary" aria-label="Previous month" onClick={() => setCalendar(new Date(calendar.getFullYear(), calendar.getMonth() - 1, 1))}>‹</Button><Button variant="secondary" onClick={() => setCalendar(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>Today</Button><Button variant="secondary" aria-label="Next month" onClick={() => setCalendar(new Date(calendar.getFullYear(), calendar.getMonth() + 1, 1))}>›</Button></Inline>} onCreateDay={day => setModal({ type: 'post', day: day + 'T12:00' })} view={calendarView} onViewChange={setCalendarView} onMonthChange={setCalendar} weekStart={calendarWeek} onWeekChange={setCalendarWeek} filters={calendarFilters} onFiltersChange={setCalendarFilters}/></Suspense>}/>}
        {page === 'Ads manager' && sections('Advertising sections', adsDirectViews.some(item => item.value === adsView) ? 'campaigns' : adsView, adsTabs, value => { setAdsView(value); setQuery(''); })}
        {page === 'Ads manager' && adsManagerViews.includes(adsView) && <AdsManager key={state.projectId} view={adsView} onView={setAdsView} connected={connected} busy={busy} data={remote.ads} query={query} columns={adsColumns} rowActions={(c: Row) => canWrite && !['rejected', 'completed', 'cancelled', 'archived', 'deleted'].includes(c.status) && <Button variant="secondary" size="sm" disabled={busy} onClick={async () => { if (c.status?.toLowerCase() === 'active' || await confirm({ title: 'Activate “' + (c.campaignName || c.name || 'this campaign') + '”?', description: 'This resumes ad spend using the budget configured with the provider.', confirmLabel: 'Activate campaign' })) changeAdStatus(c); }}>{c.status?.toLowerCase() === 'active' ? 'Pause' : 'Activate'}</Button>} range={adsRange} onRange={value => { setAdsRange(value); if (remote.ads) void loadAds(value); }} account={adsAccount} onAccount={setAdsAccount} hideAmounts={hideAmounts} onHideAmounts={hidden => { setHideAmounts(hidden); saveHideAmounts(hidden); }} network={title} request={integrate} onLoad={() => loadAds()} onOpen={c => setModal({ type: 'ad-details', item: c })} empty={<ConnectionEmpty onSettings={() => setPage('Integrations')} subject="ad accounts"/>}>{connected && <AdCampaignDiscovery key={state.projectId} request={integrate}/>}</AdsManager>}
        {page === 'Ads manager' && adsView === 'leads' && (connected ? <Suspense fallback={<StatusLine busy>Loading lead forms…</StatusLine>}><ZernioLeads key={state.projectId} projectId={state.projectId} canManage={canAdmin} canWrite={canWrite} request={api}/></Suspense> : <ConnectionEmpty onSettings={() => setPage('Integrations')} subject="ad leads"/>)}
        {page === 'OOH media' && <OohProviders onOpenIntegrations={() => setPage('Integrations')} onOpenApprovals={() => setPage('Approvals')} onSpendReview={() => { if (state.projectId) void loadApprovalSummary(state.projectId); }} key={state.projectId} projectId={state.projectId} role={workspace?.role || 'viewer'} isOperator={canMap} request={api} onInventory={items => { if (activeProject.current === state.projectId) setOohInventory(items); }} onChanged={async () => { if (activeProject.current === state.projectId) await reload(); }} bookings={<OohMap key={state.projectId} projectId={state.projectId} locations={mapLocations as any} placements={state.placements} visible={filtered(state.placements)} partners={state.providers} canWrite={canWrite} canManageMaps={canMap} formatCost={money} formatDate={date} request={api} onOpen={p => setModal({ type: 'placement', item: p })} onSelect={item => { const placement = state.placements.find(row => row.id === item.id); if (placement) setModal({ type: 'placement', item: placement }); else setNotice(item.name + ' · ' + (item.location || 'Provider screen')); }}/>}/>}
        {page === 'Asset library' && <AssetLibrary key={state.projectId} projectId={state.projectId} assets={state.assets} visibleAssets={visibleAssets} busy={busy} canWrite={canWrite} drive={remote.status?.drive} driveSyncReason={driveSyncReason} connected={!!connected} tab={tab} onTabChange={setTab} related={state} onSync={() => run(async () => { await integrate('drive/sync', {}); await reload(); }, 'Drive assets synced')} onUpload={uploadAsset} request={api} onDeliverySaved={() => { if (activeProject.current === state.projectId) run(() => reload(), 'Delivery asset saved. Review its current approval in the library.'); }} onOpen={setModal} onSetUpDrive={() => setPage('Integrations')} preview={a => a.sample ? <Creative item={a}/> : <AssetPreview key={a.url} item={a}/>}/>}
        {page === 'Field activity' && <Suspense fallback={<StatusLine busy>Loading field activity…</StatusLine>}><OfflineActivations key={state.projectId} projectId={state.projectId} brand={project?.name || 'We'} campaigns={state.campaigns} activations={state.activations || []} request={api} readOnly={!canWrite} onChanged={() => { if (activeProject.current === state.projectId) return reload(); }}/></Suspense>}
        {page === 'Media providers' && <Card as="section" headingLevel={2} title="Media providers" description="Contacts and inventory for OOH and media partnerships." actions={<Text tone="muted" size="sm">{plural(state.providers.length, 'provider')}</Text>}><DataTable ariaLabel="Media providers" searchable={false} sortable={false} pagination={false} rows={filtered(state.providers)} rowKey={p => p.id} columns={[{ key: 'name', header: 'Provider', rowHeader: true, render: p => <Inline gap={2} align="center"><Avatar name={p.name}/><Text weight="semibold">{p.name}</Text></Inline> }, { key: 'type', header: 'Specialty', render: p => p.type === 'ooh' ? 'Out of home' : 'Media partner' }, { key: 'location', header: 'Location', render: p => p.location || '—' }, { key: 'contact', header: 'Contact', render: p => p.contact ? <Link href={'mailto:' + p.contact}>{p.contact}</Link> : '—' }, { key: 'inventory', header: 'Inventory', render: p => (p.inventory ?? '—') + ' placements' }]} rowActionsLabel="Actions" rowActions={p => <Button variant="ghost" size="sm" aria-label={(canWrite ? 'Edit ' : 'View ') + p.name} onClick={() => setModal({ type: 'provider', item: p })}>{canWrite ? 'Edit' : 'View'}</Button>} emptyState={<EmptyState icon="globe" title={state.providers.length ? "No providers match this search" : "Build your media network"} description={state.providers.length ? "Try another provider name, location, or specialty." : "Add a provider to track contacts, inventory and bookings."}/>}/></Card>}
        {page === 'Integrations' && project && settingsFrame(<IntegrationSettings key={project.id + ':' + state.user.id} project={project as any} isOperator={!!state.user.isOperator} canManageProject={canMap} request={api} onChanged={async () => { if (activeProject.current !== state.projectId) return; setConnectionRevision(value => value + 1); setRemote({}); setCalendarEvents([]); setOohInventory([]); await reload(); if (activeProject.current === state.projectId) { const status = await integrate('status'); setRemote({ status }); } }} sections={{
          googleAdsNative: <Suspense fallback={<StatusLine busy>Loading the Google Shopping connection…</StatusLine>}><NativeGoogleAds mode="connection" key={'google-connection:' + state.projectId + ':' + connectionRevision} projectId={state.projectId} canWrite={canWrite} isOperator={!!state.user.isOperator} canManageProject={canMap} request={api}/></Suspense>,
          microsoftAds: <Suspense fallback={<StatusLine busy>Loading the Microsoft Advertising connection…</StatusLine>}><MicrosoftAds mode="connection" key={'microsoft-connection:' + state.projectId + ':' + connectionRevision} projectId={state.projectId} role={workspace?.role || 'viewer'} isOperator={!!state.user.isOperator} request={api}/></Suspense>,
          broadsign: <OohProviders mode="connection" key={'ooh-connection:' + state.projectId + ':' + connectionRevision} projectId={state.projectId} role={workspace?.role || 'viewer'} isOperator={canMap} request={api}/>,
          zernio: <>{connected && canAdmin && <FormActions><Button onClick={() => setModal({ type: 'connect' })}>Connect a channel</Button></FormActions>}{connected && <Suspense fallback={<StatusLine busy>Loading connection health…</StatusLine>}>{canMap && <ZernioTeam key={'team:' + state.projectId + ':' + state.user.id + ':' + connectionRevision} projectId={state.projectId} request={api}/>}<ZernioAdmin key={'admin:' + state.projectId + ':' + connectionRevision} projectId={state.projectId} canManage={canAdmin} request={api}/><ZernioAccounts key={state.projectId + ':' + connectionRevision} projectId={state.projectId} canManage={canAdmin} request={api} onAccountsChanged={accounts => { if (activeProject.current === state.projectId) setRemote((previous: any) => ({ ...previous, accounts: { accounts } })); }}/></Suspense>}</>,
        }} extraCards={connected && canAdmin ? [{ id: 'chatgptAds', title: 'ChatGPT advertising', description: 'Connect the ad account through Zernio with an API key from ChatGPT Ads Manager. Each key covers one advertising account and carries campaign write access.', body: <OpenAIConnection key={state.projectId} request={integrate} onConnected={() => { setConnectionRevision(value => value + 1); run(async () => { await loadRemote('accounts', 'accounts'); }); }}/> }] : []}/>)}
        {page === 'Ads manager' && <Suspense fallback={<StatusLine busy>Loading advertising tools…</StatusLine>}>{adsView === 'events' && (connected ? <ZernioAdEvents key={state.projectId} projectId={state.projectId} request={api}/> : <ConnectionEmpty onSettings={() => setPage('Integrations')} subject="ad activity"/>)}{adsView === 'measurement' && (connected ? <ZernioMeasurement key={state.projectId} projectId={state.projectId} canManage={canAdmin} request={api}/> : <ConnectionEmpty onSettings={() => setPage('Integrations')} subject="conversions"/>)}{adsView === 'search' && (connected ? <GoogleAdsTools key={state.projectId} request={integrate} canWrite={canWrite}/> : <ConnectionEmpty onSettings={() => setPage('Integrations')} subject="Google Ads"/>)}{adsView === 'shopping' && <NativeGoogleAds onOpenIntegrations={() => setPage('Integrations')} onOpenApprovals={() => setPage('Approvals')} key={'google:' + state.projectId} projectId={state.projectId} canWrite={canWrite} isOperator={!!state.user.isOperator} canManageProject={canMap} request={api} onChanged={() => { if (activeProject.current === state.projectId) return reload(); }}/>}{adsView === 'microsoft' && <MicrosoftAds onOpenIntegrations={() => setPage('Integrations')} onOpenApprovals={() => setPage('Approvals')} key={'microsoft:' + state.projectId} projectId={state.projectId} role={workspace?.role || 'viewer'} isOperator={!!state.user.isOperator} request={api} onChanged={() => { run(() => reload()); }}/>}</Suspense>}{page === 'Settings' && settingsFrame(<>{section === 'general' && <Card as="section" headingLevel={2} title="Project"><Stack gap={3}><Stack as="form" gap={3} key={project?.id} onSubmit={e => { e.preventDefault(); const requestProject = state.projectId, name = String(new FormData(e.currentTarget as HTMLFormElement).get('name')); run(async () => { await api('/projects/' + project!.id, 'PATCH', { name }); if (activeProject.current === requestProject) await reload(); }, 'Project settings saved'); }}><Field label="Project name" name="name" defaultValue={project?.name} required disabled={!canAdmin}/>{canAdmin && <FormActions><Button type="submit" variant="primary" disabled={busy}>Save project name</Button></FormActions>}</Stack>{canAdmin && sample && <DangerZoneFlow busy={busy} actions={[{ id: 'sample-data', title: 'Remove sample data', description: 'Removes every sample record from this project, including sample records you edited. Your own campaigns, assets and bookings stay. Unassign any sample records used by your own work first.', confirmLabel: 'Remove sample data' }]} onConfirm={clearSampleData}/>}</Stack></Card>}{section === 'approvals' && <ApprovalPolicy key={state.projectId + ':' + state.user.id} projectId={state.projectId} role={workspace?.role || 'viewer'} request={api} onChanged={() => { if (activeProject.current === state.projectId) return reload(); }}/>}{section === 'activity' && <OperationRecovery key={'receipts:' + state.projectId} projectId={state.projectId} role={workspace?.role || 'viewer'} isOperator={!!state.user.isOperator} request={api} onReviewed={resolution => { if (resolution === 'not_applied' && activeProject.current === state.projectId) pendingKeys.current.clear(); }}/>}{section === 'members' && <Stack gap={4}><Card as="section" headingLevel={2} title="Workspace"><Stack gap={2}><Text><Text as="strong">{workspace?.name}</Text> · {title(workspace?.role)}</Text><Text tone="muted" size="sm">Workspace membership applies to every project in this workspace.</Text><Inline><Button variant="secondary" onClick={() => setModal({ type: 'workspace' })}>New workspace</Button></Inline>{workspace && <DangerZoneFlow busy={busy} title="Leave workspace" actions={[{ id: 'leave-workspace', title: 'Leave this workspace', description: 'You lose access to every project in this workspace.' + (workspace.role === 'owner' ? ' A workspace keeps at least one owner, so make another member an owner first.' : ' To return, you need a new invitation.'), confirmLabel: 'Leave workspace' }]} onConfirm={leaveWorkspace}/>}</Stack></Card>{canAdmin && workspace && <TeamSettings key={workspace.id} workspaceId={workspace.id} role={workspace.role} currentUserId={state.user.id} request={api}/>}</Stack>}{section === 'profile' && <AccountSettings key={state.user.id} part="profile" request={api} onChanged={() => { if (activeProject.current === state.projectId) run(() => reload()); }}/>}{section === 'security' && <AccountSettings key={state.user.id} part="security" request={api} onChanged={() => { if (activeProject.current === state.projectId) run(() => reload()); }}/>}{section === 'sign-in' && state.user.isOperator && <Card as="section" headingLevel={2} title="Sign-in"><Stack gap={2}><Text>Email and password sign-in is on. Single sign-on is {session.oidcEnabled ? 'on' : 'off'}.</Text><Text tone="muted" size="sm">Single sign-on is set in the server configuration. <Link href="https://github.com/Ten98-IO-Company/ten98-campaign/wiki/Configuration#sign-in-and-security" target="_blank" rel="noreferrer">How to set up sign-in</Link></Text></Stack></Card>}</>)}
    </AppShell>
    <Dialog open={!!modal} size={modal?.type === 'post' ? 'wide' : 'default'} footer={modal?.type === 'post' && !modal.item?.externalId ? <Inline ref={setComposerActions} gap={2}/> : undefined} onOpenChange={open => { if (!open) closeEditor(); }} onBeforeClose={() => { cancelEditor(); return false; }} eyebrow={project?.name || 'Your workspace'} title={!modal ? 'Editor' : nameFlow ? 'New ' + modal.type : <>{modal.type === 'product-state' ? 'Review ' : modal.type === 'product-create' ? 'New ' : modal.type === 'blog-draft' ? modal.item?.article ? modal.item.article.publicationState === 'published' ? 'Edit published ' : 'Edit ' : 'New ' : modal.type === 'ad' && modal.item ? 'Review ' : modal.item ? providerManaged || modal.type === 'ad-details' || !canWrite ? 'View ' : modal.type === 'post' && (modal.item.externalId || modal.item.status === 'published') ? 'View ' : 'Edit ' : 'New '}{({ campaign: 'campaign', post: 'post', placement: 'OOH booking', asset: 'asset', 'asset-delivery': 'delivery file', provider: 'media provider', ad: 'ad campaign', 'ad-details': 'ad details', connect: 'channel connection', 'blog-draft': modal.item?.article?.publicationState === 'published' ? 'article' : 'blog draft', 'product-edit': 'store product', 'product-create': 'draft store product', 'product-price': 'product price', 'product-state': modal.item?.stateAction === 'delete' ? 'permanently delete product' : modal.item?.stateAction === 'archive' ? 'archive product' : modal.item?.stateAction === 'activate' ? 'activate product' : 'move to draft', 'collection-title': 'collection title' } as Record<string, string>)[modal.type]}</>}><Stack ref={dialogRef} gap={4} onInputCapture={event => markEditorDirty(event.target as Element)} onChangeCapture={event => markEditorDirty(event.target as Element)} onClickCapture={watchEditorButtons}>
      {modal && (nameFlow ? modal.type === 'project' ? <ProjectCreateFlow mode="create" defaultValues={{ name: '', origin: '' }} showOrigin={false} busy={busy} error={error || undefined} onSubmit={saveEditor} cancel={{ label: 'Cancel', onClick: closeEditor }} title="New project" hideTitle description="Projects organize campaigns, channel connections, and assets within your workspace."/> : <WorkspaceCreateFlow mode="create" defaultValues={{ name: '' }} busy={busy} error={error || undefined} onSubmit={saveEditor} cancel={{ label: 'Cancel', onClick: closeEditor }} title="New workspace" hideTitle description="A workspace separates teams and access. A first project is created with it."/> : <>{modal.type === 'connect' ? <Suspense fallback={<StatusLine busy>Loading connection options…</StatusLine>}><ZernioConnection key={state.projectId} projectId={state.projectId} canManage={canAdmin} request={api} onCancel={closeEditor} onConnected={() => { if (activeProject.current === state.projectId) { setModal(null); setConnectionRevision(value => value + 1); setNotice('Connection confirmed in this project.'); run(async () => { await loadRemote('accounts', 'accounts'); await reload(); }); } }}/></Suspense> : modal.type === 'blog-draft' ? <Suspense fallback={<StatusLine busy>Loading article editor…</StatusLine>}><BlogDraftComposer key={state.projectId + ':blog:' + modal.item?.id} account={modal.item!.account} blog={modal.item!.blog} article={modal.item!.article} readOnly={!canWrite} request={editorIntegrate}/></Suspense> : modal.type === 'product-create' ? <Suspense fallback={<StatusLine busy>Loading draft product editor…</StatusLine>}><ProductCreator key={state.projectId + ':product-create:' + modal.item?.id} account={modal.item!.account} store={modal.item!.store} readOnly={!canWrite} request={editorIntegrate}/></Suspense> : modal.type === 'product-price' ? <Suspense fallback={<StatusLine busy>Loading product price editor…</StatusLine>}><ProductPriceEditor key={state.projectId + ':product-price:' + modal.item?.id} account={modal.item!.account} store={modal.item!.store} product={modal.item!.product} readOnly={!canWrite} request={editorIntegrate}/></Suspense> : modal.type === 'collection-title' ? <Suspense fallback={<StatusLine busy>Loading collection title editor…</StatusLine>}><CollectionTitleEditor key={state.projectId + ':collection-title:' + modal.item?.id} account={modal.item!.account} store={modal.item!.store} collection={modal.item!.collection} readOnly={!canWrite} request={editorIntegrate}/></Suspense> : modal.type === 'product-state' ? <Suspense fallback={<StatusLine busy>Loading product status review…</StatusLine>}><ProductStateReview key={state.projectId + ':product-state:' + modal.item?.id + ':' + (modal.item?.stateAction || 'deactivate')} stateAction={modal.item?.stateAction} account={modal.item!.account} store={modal.item!.store} product={modal.item!.product} readOnly={!canWrite} request={editorIntegrate}/></Suspense> : modal.type === 'product-edit' ? <Suspense fallback={<StatusLine busy>Loading product editor…</StatusLine>}><ProductEditor key={state.projectId + ':product:' + modal.item?.id} account={modal.item!.account} store={modal.item!.store} product={modal.item!.product} readOnly={!canWrite} request={editorIntegrate}/></Suspense> : modal.type === 'post' && modal.item?.externalId ? <PostManagement key={state.projectId + ':' + modal.item.id} post={modal.item} request={editorIntegrate} onRequestReview={(path, body) => { const requestProject = state.projectId; return api(endpoint(path), 'POST', body).then(result => { if (activeProject.current !== requestProject) throw new DOMException('Project changed.', 'AbortError'); return result; }); }} onShortenLinks={shortenEditorLinks} canWrite={canWrite} assets={state.assets} campaigns={state.campaigns} accounts={remote.accounts?.accounts || []} onCancel={closeEditor} onChanged={() => { if (activeProject.current === state.projectId) run(() => reload()); }}/> : modal.type === 'post' ? <PostComposer key={state.projectId + ':' + (modal.item?.id || 'new')} post={modal.item} assets={state.assets} campaigns={state.campaigns} accounts={remote.accounts?.accounts || []} canWrite={canWrite} busy={busy} readOnly={modal.item?.status === 'published'} initialScheduledAt={modal.day} actionsHost={composerActions} onSubmit={savePost} onSchedule={schedulePost} connected={!!connected} publishBlock={composerPublishBlock} onOpenIntegrations={() => setPage('Integrations')}onCancel={closeEditor} onDelete={modal.item ? async () => { if (await confirm({ title: 'Delete this post?', description: 'This removes the local draft.', confirmLabel: 'Delete', danger: true })) await remove('posts', modal.item!); } : undefined} onLoadAccounts={connected ? () => loadRemote('accounts', 'accounts') : undefined} onShortenLinks={shortenEditorLinks} onValidate={values => integrate('social/validate', values)} onInspectMedia={item => integrate('social/validate-media', { url: item.url })} onLoadQueues={() => integrate('queues')} onLoadGroups={() => integrate('admin/overview')} onLookupDestinations={(accountId, resource, params = {}) => integrate(`publishing/accounts/${encodeURIComponent(accountId)}/${encodeURIComponent(resource)}?${new URLSearchParams(params)}`)} onTikTokInfo={(accountId, mediaType) => integrate(`social/tiktok-creator-info?accountId=${encodeURIComponent(accountId)}&mediaType=${encodeURIComponent(mediaType)}`)}/> : modal.type === 'ad-details' ? <AdDetails request={integrate} campaign={modal.item} canWrite={canWrite} onOpenApprovals={() => setPage('Approvals')}onChanged={() => { run(async () => { await reload(); await loadRemote('ads', 'ads'); }); }}/> : modal.type === 'ad' ? <AdComposer request={integrate} readOnly={!canWrite} initialDraft={modal.item} posts={state.posts} onCancel={closeEditor} onCreated={message => { setModal(null); setNotice(message || 'Ad created paused. Activate it when you are ready.'); run(async () => { await reload(); await loadRemote('ads', 'ads'); }); }}/> : modal.type === 'asset-delivery' ? <Suspense fallback={<StatusLine busy>Loading upload controls…</StatusLine>}><ZernioMediaUpload key={state.projectId + ':delivery:' + modal.item?.id} projectId={state.projectId} assetId={modal.item?.id} configured={connected} disabled={!canWrite || busy} request={api} onSaved={() => { if (activeProject.current === state.projectId) run(async () => { await reload(); if (modalRef.current === modal) setModal(null); }, 'Upload completed. Review the saved delivery file and approval.'); }}/></Suspense> : <Stack as="form" gap={4} onSubmit={submitForm} key={modal.type + (modal.item?.id || '')}><Stack as="fieldset" gap={4} disabled={busy || providerManaged || !canWrite || (modal.type === 'post' && !!(modal.item?.externalId || modal.item?.status === 'published'))}>
      {providerManaged && <Alert tone="warning">This record is managed by its provider. Use the Ads manager or Broadsign controls to change delivery, dates, or budget.</Alert>}{modal.type === 'campaign' && <><Field label="Campaign name" name="name" defaultValue={modal.item?.name} placeholder="Campaign name" required maxLength={120}/><FormGrid><Field label="Start date" name="startDate" type="date" defaultValue={modal.item?.startDate?.slice(0, 10)}/><Field label="End date" name="endDate" type="date" defaultValue={modal.item?.endDate?.slice(0, 10)}/></FormGrid><FormGrid><Field label="Budget" name="budget" type="number" min="0" step="0.01" defaultValue={modal.item?.budget || 0}/><Select label="Currency" name="currency" value={modal.item?.currency || 'AED'} options={['AED', 'USD', 'EUR', 'GBP']}/></FormGrid><Disclosure summary="More details" defaultOpen={!!modal.item}><FormGrid><Select label="Channel" name="channel" value={modal.item?.channel || 'mixed'} options={Object.entries(channels)}/><Select label="Status" name="status" value={modal.item?.status || 'draft'} options={['draft', 'active', 'paused', 'completed']}/></FormGrid><Field label="Description" name="description" defaultValue={modal.item?.description} multiline/></Disclosure>{modal.item && <Disclosure summary="Tracked results"><Text tone="muted" size="sm">Enter manual totals for this campaign. Live network metrics stay in Ads manager.</Text><FormGrid><Field label="Spend to date" name="spent" type="number" min="0" step="0.01" defaultValue={modal.item?.spent || 0}/><Field label="Impressions" name="impressions" type="number" min="0" defaultValue={modal.item?.impressions || 0}/><Field label="Clicks" name="clicks" type="number" min="0" defaultValue={modal.item?.clicks || 0}/><Field label="Conversions" name="conversions" type="number" min="0" defaultValue={modal.item?.conversions || 0}/></FormGrid></Disclosure>}</>}
      {modal.type === 'placement' && <BookingFields item={modal.item} partners={state.providers} campaigns={state.campaigns}/>}
      {modal.type === 'asset' && <><Field label="Asset name" name="name" defaultValue={modal.item?.name} required/><Field label="Asset link" name="url" type="url" defaultValue={modal.item?.url} placeholder="https://drive.google.com/…" required/><Field label="Public delivery URL (optional)" name="deliveryUrl" type="url" defaultValue={modal.item?.deliveryUrl || ''} placeholder="https://your-media-host.example/creative.jpg"/><Text tone="muted" size="sm">Keep your original in Drive. Add a public media URL here when this asset will be published to social or advertising channels. Changing the creative link resets its approval.</Text><FormGrid><Select label="Type" name="kind" value={modal.item?.kind || 'image'} options={['image', 'video', 'document']}/><Select label="Approval" name="approval" value={modal.item?.approval || 'pending'} options={['pending', 'approved', 'rejected']}/></FormGrid><Field label="Tags" name="tags" defaultValue={modal.item?.tags?.join(', ')} placeholder="brand, summer, social"/><Field label="Alt text / description" name="description" defaultValue={modal.item?.description} multiline/>{modal.item?.url && <Link variant="standalone" href={modal.item.url} target="_blank" rel="noreferrer">Open original</Link>}</>}
      {modal.type === 'provider' && <><Field label="Provider name" name="name" defaultValue={modal.item?.name} required/><Select label="Specialty" name="type" value={modal.item?.type || 'ooh'} options={[["ooh", 'Out of home'], ["media", 'Media partner']]}/><Field label="Contact email" name="contact" type="email" defaultValue={modal.item?.contact}/><Field label="Location" name="location" defaultValue={modal.item?.location}/><Field label="Available placements" name="inventory" type="number" min="0" defaultValue={modal.item?.inventory || 0}/><Field label="Notes" name="notes" multiline defaultValue={modal.item?.notes}/></>}

      </Stack><FormActions>{modal.item && canWrite && !providerManaged && <Button variant="danger" disabled={busy} onClick={async () => { const collection = ({ campaign: 'campaigns', post: 'posts', placement: 'placements', asset: 'assets', provider: 'providers' } as Record<string, string>)[modal.type], item = modal.item!; if (await confirm({ title: `Delete “${item.name || 'this draft'}”?`, description: 'This removes the local record.', confirmLabel: 'Delete', danger: true })) await remove(collection, item); }}>Delete</Button>}<Button variant="secondary" onClick={closeEditor}>Cancel</Button>{canWrite && !providerManaged && <Button type="submit" variant="primary" disabled={busy || !!(modal.type === 'post' && (modal.item?.externalId || modal.item?.status === 'published'))}>{busy ? 'Saving…' : modal.item ? 'Save changes' : modal.type === 'post' ? 'Save draft' : 'Create ' + (({ placement: 'booking', connect: 'connection' } as Record<string, string>)[modal.type] || modal.type)}</Button>}</FormActions>{error && <Alert tone="danger">{error}</Alert>}</Stack>}</>)}
    </Stack></Dialog>
    {/* Publishing goes to real accounts, so the card asks once and names every destination (Mixpost's publish confirmation, #39). */}
    <ConfirmDialog open={!!publishing} onOpenChange={open => { if (!open) setPublishing(null); }} title={publishing?.queueId ? 'Add this post to its queue?' : publishing?.status === 'scheduled' ? 'Schedule this post?' : 'Publish this post now?'} description={publishing?.queueId ? 'Zernio reserves the next free slot in the selected queue and publishes the post then.' : publishing?.status === 'scheduled' ? 'Zernio publishes the post at its planned time to every account below.' : 'Zernio publishes the post immediately to every account below.'} confirmLabel={publishing?.queueId ? 'Add to queue' : publishing?.status === 'scheduled' ? 'Schedule post' : 'Publish now'} onConfirm={async () => { const post = publishing; if (post) await publish(post); setPublishing(null); }}>{publishing && <Stack gap={1}><Text size="sm"><Text as="strong">Accounts:</Text> {postRecipients(publishing, remote.accounts?.accounts || [])}</Text>{publishing.scheduledAt && !publishing.queueId && <Text size="sm"><Text as="strong">Planned time:</Text> {new Date(publishing.scheduledAt).toLocaleString()}</Text>}</Stack>}</ConfirmDialog>
    {confirmDialog}
    <ConfirmDialog open={discardPrompt} onOpenChange={open => { if (!open) keepEditing(); }} danger title="Discard unsaved changes?" description="Your edits will be lost." confirmLabel={discardSwitch.current ? 'Discard and switch' : 'Discard changes'} cancelLabel="Keep editing" onConfirm={discardChanges}/>
  </>;
}
function Select({ label, name, value, options }: { label: string; name: string; value: string; options: (string | string[])[] }) { return <AppSelect label={label} name={name} value={value} options={options.map(o => typeof o === 'string' ? [o, title(o)] : [o[0], o[1]])}/>; }
function ConnectionEmpty({ onSettings, subject }: { onSettings: () => void; subject: string }) { return <Card><EmptyState icon="link" title={'Connect your accounts to use ' + subject} description="Connect your social and ad accounts once in Settings › Connections. They then work across Campaign." action={<Button variant="primary" onClick={onSettings}>Open Connections</Button>}/></Card>; }
// Identity sign-in failures return as /?auth_error=<CODE> (plus any held #invite=). Only a known code selects a message, so
// query text is never shown. The code is read once at startup and removed from the address; the invitation stays.
const oidcSignInErrors: Record<string, string> = {
  OIDC_INVITE_EMAIL_MISMATCH: 'This invitation is for a different email address. Sign in with the identity that uses the invited email.',
  OIDC_NOT_PROVISIONED: 'This identity does not have access yet. Ask the instance operator for access or a workspace invitation.',
  OIDC_EMAIL_UNVERIFIED: 'Your identity provider has not verified this email address. Verify it there, then sign in again.',
  OIDC_ACCOUNT_EXISTS: 'An account already uses this email address, and single sign-on is not linked to it automatically. Sign in with your email and password.',
  OIDC_RATE_LIMITED: 'Too many sign-in attempts. Wait a few minutes, then try again.',
  OIDC_SIGN_IN_FAILED: 'Single sign-on could not be completed. It may have expired or already been used. Start again.',
};
function takeAuthError(location: Pick<Location, 'pathname' | 'search' | 'hash'>, history: Pick<History, 'state' | 'replaceState'>) {
  const params = new URLSearchParams(location.search), code = params.get('auth_error');
  if (code === null) return '';
  params.delete('auth_error'); const query = params.toString();
  history.replaceState(history.state, '', location.pathname + (query ? '?' + query : '') + location.hash);
  return Object.hasOwn(oidcSignInErrors, code) ? oidcSignInErrors[code] : oidcSignInErrors.OIDC_SIGN_IN_FAILED;
}
let startupAuthError = takeAuthError(window.location, window.history);
// Invitation links carry the token in #invite= (older links: ?invite=). It is read once at startup into memory and
// removed from the address and this history entry; a fragment holding it is dropped whole.
function takeInvite(location: Pick<Location, 'pathname' | 'search' | 'hash'>, history: Pick<History, 'state' | 'replaceState'>) {
  const params = new URLSearchParams(location.search), token = new URLSearchParams(location.hash.slice(1)).get('invite') ?? params.get('invite');
  if (token === null) return '';
  params.delete('invite'); const query = params.toString();
  history.replaceState(history.state, '', location.pathname + (query ? '?' + query : ''));
  return token;
}
const startupInvite = takeInvite(window.location, window.history);
// A link pasted into an open tab changes only the fragment, so the running app reads it the same way.
function watchInvite(target: Pick<Window, 'location' | 'history' | 'addEventListener' | 'removeEventListener'>, onInvite: (token: string) => void) {
  const read = () => { const token = takeInvite(target.location, target.history); if (token) onInvite(token); };
  target.addEventListener('hashchange', read);
  return () => target.removeEventListener('hashchange', read);
}
// Campaign adapter: the host-held setup token, sample opt-in and invitation continuation stay app-owned.
// With an invitation in memory the screen says so, prefills the invited email and offers a way back; signing in returns to the invitation.
function Auth({ session, inviteToken = '', inviteEmail = '', onBackToInvitation, error, busy, onSubmit, onOidcStart }: { session: any; inviteToken?: string; inviteEmail?: string; onBackToInvitation?: () => void; error: string; busy: boolean; onSubmit: (data: any) => void; onOidcStart?: () => void }) {
  const frame = { surface: 'card' as const, brand: <Brand product="Campaign" href="/"/>, label: 'Campaign sign in', eyebrow: 'YOUR WORKSPACE', error: error || startupAuthError || undefined, busy, busyLabel: 'Signing in…',
    aside: <AuthStory label="Campaign overview" eyebrow="CAMPAIGN MANAGEMENT" title="Plan. Publish." emphasis="Measure." lead="Manage social posts, advertising and campaign assets." channels={[{ icon: 'send', label: 'Social' }, { icon: 'target', label: 'Advertising' }, { icon: 'billboard', label: 'Out of home' }]} footnote="ten98 Campaign"/> };
  if (session.setupRequired) return <FirstUserSetupFlow {...frame} title="Create owner account" description="Create the owner account for this app." submitLabel="Create owner account" tokenLength={{ min: 32, max: 512 }} tokenHint="Ask the person running this app for the setup token." passwordPolicy={{ minLength: 12, maxLength: 128, hint: 'Use at least 12 characters.' }} sampleOptIn={{ label: 'Include a sample project to explore', defaultChecked: true }} onSubmit={({ name, token, email, password, sample }) => onSubmit({ name, token, email, password, sample })}/>;
  // Invitation sign-in starts with a POST that carries the token; plain sign-in stays a link.
  const sso = inviteToken ? { id: 'sso', name: 'Organization single sign-on' } : { id: 'sso', name: 'Organization single sign-on', href: '/api/auth/oidc/start' };
  const invitation = inviteToken ? { title: 'Sign in to join', description: inviteEmail ? `Sign in as ${inviteEmail} to accept your workspace invitation.` : 'Sign in with the invited email to accept your workspace invitation.', defaultValues: inviteEmail ? { email: inviteEmail } : undefined, cancel: onBackToInvitation ? { label: 'Back to invitation', onClick: onBackToInvitation } : undefined } : { title: 'Sign in', description: 'Use your account to access your workspaces.' };
  const ended = session.unsavedChangesLost ? 'Your session ended before your changes were saved. Sign in again, then make those changes again.' : 'Your session ended. Sign in again.';
  return <SignInFlow {...frame} {...invitation} notice={session.sessionEnded ? { tone: 'warning', text: ended } : undefined} submitLabel="Sign in" passwordPolicy={{ maxLength: 128 }} onSubmit={({ email, password }) => { startupAuthError = ''; onSubmit({ email, password }); }} providers={session.oidcEnabled ? <OidcProviderButtons providers={[sso]} onStart={onOidcStart} dividerLabel="or continue with"/> : undefined}/>;
}

createRoot(document.getElementById('root')!).render(<AuthErrorBoundary fallback={{ brand: <Brand product="Campaign"/>, title: 'Page unavailable', message: 'This screen could not load. Reload the app to try again.', retryLabel: 'Reload app' }}><ToastProvider><App/></ToastProvider></AuthErrorBoundary>);
