"use client";

import { useEffect } from "react";
import { registerSW } from "@/lib/register-sw";

/** Registers the Beam app-shell service worker (production only). */
export function SWRegister() {
  useEffect(() => {
    void registerSW();
  }, []);
  return null;
}
