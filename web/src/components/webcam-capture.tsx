"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { renderDevicePhoto } from "@/lib/photo";

export function WebcamCapture({
  onCapture,
  disabled = false,
}: {
  onCapture: (file: File) => void;
  disabled?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [capturing, setCapturing] = useState(false);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
  }

  useEffect(() => {
    const video = videoRef.current;
    if (video && stream) {
      video.srcObject = stream;
      void video.play();
    }
  }, [stream]);

  useEffect(() => () => streamRef.current?.getTracks().forEach((track) => track.stop()), []);

  async function startCamera() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        "The browser blocks the camera on a plain-HTTP LAN address. Ask your administrator to run enable-webcam-on-operator-pc.ps1 on this PC (see the Install Guide), or upload a photo.",
      );
      return;
    }

    try {
      setStarting(true);
      const nextStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      streamRef.current = nextStream;
      setStream(nextStream);
    } catch {
      setError("Camera access was unavailable or denied. Allow it in the browser, or upload a photo.");
    } finally {
      setStarting(false);
    }
  }

  function capture() {
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight) {
      setError("The camera is still starting. Try again in a moment.");
      return;
    }

    setCapturing(true);
    renderDevicePhoto(video, video.videoWidth, video.videoHeight)
      .then((file) => {
        onCapture(file);
        stopCamera();
      })
      .catch(() => setError("The browser could not capture the photo. Please try again."))
      .finally(() => setCapturing(false));
  }

  return (
    <div className="space-y-2">
      {!stream ? (
        <Button
          type="button"
          loading={starting}
          disabled={disabled}
          onClick={() => void startCamera()}
        >
          Use webcam
        </Button>
      ) : (
        <div className="space-y-2 rounded-[var(--radius)] border border-[var(--border)] p-2">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            aria-label="Webcam preview"
            className="w-full rounded-[var(--radius)] bg-black object-cover"
          />
          <div className="flex gap-2">
            <Button type="button" variant="primary" loading={capturing} onClick={capture}>
              Capture photo
            </Button>
            <Button type="button" disabled={capturing} onClick={stopCamera}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
