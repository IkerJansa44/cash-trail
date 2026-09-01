const appBase = import.meta.env.BASE_URL.replace(/\/$/, "");

export async function apiRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${appBase}${url}`, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: "Something went wrong" }));
    throw new Error(body.detail || "Something went wrong");
  }
  return response.json();
}

export function uploadRequest<T>(url: string, body: FormData, onProgress: (percentage: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `${appBase}${url}`);
    request.responseType = "json";
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100));
    });
    request.upload.addEventListener("load", () => onProgress(100));
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        resolve(request.response as T);
        return;
      }
      reject(new Error(request.response?.detail || "Something went wrong"));
    });
    request.addEventListener("error", () => reject(new Error("Unable to reach the server")));
    request.send(body);
  });
}
