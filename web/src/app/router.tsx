import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AppShell } from './layout/app-shell';
import { Dashboard } from '../features/dashboard/dashboard';
import { Login } from '../features/auth/login';
import { DeviceList, DeviceDetails } from '../features/devices/devices';
import { SmsPage } from '../features/sms/sms';
import { useSession } from '../stores/session';
import { Channels } from '../features/channels/channels';
import { Calls } from '../features/calls/calls';
import { CallDetailPage } from '../features/calls/call-detail';
import { SettingsPage } from '../features/settings/settings';
import { RecordsPage } from '../features/records/records';
const names = ['commands','alerts','audit'] as const;
function Guard() { const session=useSession(state=>state.session); const location=useLocation(); if (!session || session.expiresAt <= Date.now()) return <Navigate to="/login" replace state={{from:location.pathname + location.search}}/>; return <Outlet/>; }
function NotFound() { const { t } = useTranslation(); return <div className="panel empty"><h1>{t('notFound')}</h1><Link to="/dashboard">{t('backDashboard')}</Link></div>; }
export function AppRouter() { return <BrowserRouter><Routes><Route path="/login" element={<Login/>}/><Route element={<Guard/>}><Route element={<AppShell/>}><Route index element={<Navigate to="/dashboard" replace/>}/><Route path="dashboard" element={<Dashboard/>}/><Route path="devices" element={<DeviceList/>}/><Route path="devices/:deviceId" element={<DeviceDetails/>}/><Route path="sms" element={<SmsPage/>}/><Route path="sms/:threadKey" element={<SmsPage/>}/><Route path="channels" element={<Channels/>}/><Route path="calls" element={<Calls/>}/><Route path="calls/:sessionId" element={<CallDetailPage/>}/><Route path="settings" element={<SettingsPage/>}/>{names.map(name => <Route key={name} path={name + '/*'} element={<RecordsPage kind={name}/>}/>)}<Route path="*" element={<NotFound/>}/></Route></Route></Routes></BrowserRouter>; }
