/** Event-driven preparation after input is visible, never an awaited prompt dependency.
 * Single-flight and rate-limited: no idle polling or unbounded hidden inference loop.
 * This prepares advisory cache only; launches retain their own admission/lease checks.
 */
export class BackgroundReadiness {
  #prepare; #now; #interval; #deadline; #timer; #running; #controller; #lastStarted=-Infinity; #closed=false;
  constructor({prepare,now=Date.now,minIntervalMs=30_000,deadlineMs=180_000}={}) {
    if(typeof prepare!=='function'||typeof now!=='function'||!Number.isFinite(minIntervalMs)||minIntervalMs<0||!Number.isFinite(deadlineMs)||deadlineMs<1)
      throw new Error('invalid background readiness preparation');
    this.#prepare=prepare;this.#now=now;this.#interval=minIntervalMs;this.#deadline=deadlineMs;
  }
  get pending(){return !!this.#timer||!!this.#running;}
  schedule() {
    if(this.#closed||this.pending||this.#now()-this.#lastStarted<this.#interval)return false;
    this.#timer=setTimeout(()=>{
      this.#timer=undefined;
      if(this.#closed)return;
      this.#lastStarted=this.#now();
      const run=this.#run();this.#running=run;
      void run.finally(()=>{if(this.#running===run)this.#running=undefined;}).catch(()=>{});
    },0);
    this.#timer.unref?.();
    return true;
  }
  async #run() {
    const controller=new AbortController();this.#controller=controller;
    const deadline=setTimeout(()=>controller.abort(),this.#deadline);deadline.unref?.();
    let abort;
    try {
      await Promise.race([
        Promise.resolve().then(()=>{if(!controller.signal.aborted)return this.#prepare({signal:controller.signal});}),
        new Promise(resolve=>{abort=()=>resolve();controller.signal.addEventListener('abort',abort,{once:true});}),
      ]);
    } catch { /* Failed preparation is not a negative availability verdict. */ }
    finally {
      clearTimeout(deadline);controller.signal.removeEventListener('abort',abort);
      controller.abort();if(this.#controller===controller)this.#controller=undefined;
    }
  }
  async close() {
    this.#closed=true;
    if(this.#timer)clearTimeout(this.#timer);
    this.#timer=undefined;this.#controller?.abort();
    await this.#running;
  }
}
