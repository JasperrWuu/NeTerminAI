import { useEffect, useState } from "react";
import { startSavedFtp } from "./ftpStartup";
import { useNativeSurfaceOcclusion } from "../ui/nativeSurfaceOcclusion";
import "./ftp.css";
export function FtpStartupNotice() {
  const [error, setError] = useState<string | null>(null);
  useNativeSurfaceOcclusion(Boolean(error));
  useEffect(() => { let active = true; void startSavedFtp().then((value) => { if (active) setError(value); }); return () => { active = false; }; }, []);
  return error ? <aside role="alert" className="ftp-startup-feedback"><strong>FTP 自动启动失败</strong><p>{error}</p><button type="button" className="secondary-button" onClick={() => setError(null)}>知道了</button></aside> : null;
}
