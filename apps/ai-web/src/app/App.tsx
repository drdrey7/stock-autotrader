import { Route, Routes } from "react-router-dom";
import { LandingPage } from "../pages/LandingPage";
import { AppPage } from "../pages/AppPage";
import { ReportPage } from "../pages/ReportPage";
import { AccountPage } from "../pages/AccountPage";
import { AuthPage } from "../pages/AuthPage";
import { SponsorPage } from "../pages/SponsorPage";

export function App() { return <Routes><Route path="/" element={<LandingPage />} /><Route path="/app" element={<AppPage />} /><Route path="/report/:id" element={<ReportPage />} /><Route path="/account" element={<AccountPage />} /><Route path="/auth" element={<AuthPage />} /><Route path="/sponsor/:slot" element={<SponsorPage />} /><Route path="*" element={<LandingPage />} /></Routes>; }
