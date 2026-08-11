const appBase = import.meta.env.BASE_URL.replace(/\/$/, "");

export async function apiRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${appBase}${url}`, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: "Something went wrong" }));
    throw new Error(body.detail || "Something went wrong");
  }
  return response.json();
}
