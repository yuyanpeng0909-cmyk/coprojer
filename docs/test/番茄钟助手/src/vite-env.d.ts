declare module '*.css';
declare global { interface Window { desktop?: { notify: (title:string, body:string)=>Promise<boolean> } } }
export {};
