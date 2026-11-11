import { afterEach, expect, it, vi } from "vitest";
import { PreviewScrollCoordinator, scrollSteps } from "./preview-scroll-coordinator";

afterEach(() => vi.useRealTimers());

it("coalesces both axes and retains swipes received during an in-flight screenshot", async () => {
  vi.useFakeTimers();
  const sent: Array<{x:number;y:number}> = [];
  const releases: Array<() => void> = [];
  const changed = vi.fn(), drained = vi.fn();
  const coordinator = new PreviewScrollCoordinator(async (delta) => { sent.push(delta); await new Promise<void>(resolve => releases.push(resolve)); }, () => true, changed, drained);
  coordinator.add({x:100,y:200});coordinator.add({x:50,y:30});
  await vi.advanceTimersByTimeAsync(45);
  expect(sent).toEqual([{x:150,y:230}]);
  coordinator.add({x:-20,y:70});coordinator.add({x:10,y:30});
  expect(sent).toHaveLength(1);
  releases.shift()!();await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(45);
  expect(sent).toEqual([{x:150,y:230},{x:-10,y:100}]);
  releases.shift()!();await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.hasPending).toBe(false);
  expect(drained).toHaveBeenCalled();
});

it("sends bounded chunks and cancels pending gestures without another request", async () => {
  vi.useFakeTimers();
  const sent: Array<{x:number;y:number}> = [];
  const coordinator = new PreviewScrollCoordinator(async delta => {sent.push(delta);},()=>true,()=>{},()=>{});
  coordinator.add({x:6200,y:-6100});
  await vi.advanceTimersByTimeAsync(100);
  expect(sent).toEqual([{x:5000,y:-5000},{x:1200,y:-1100}]);
  coordinator.add({x:400,y:400});coordinator.clear();
  await vi.advanceTimersByTimeAsync(100);
  expect(sent).toHaveLength(2);
});

it("splits saved x/y movement into valid Browser Steps without changing totals", () => {
  const steps=scrollSteps({x:9100,y:-12300},20)!;
  expect(steps).toHaveLength(3);
  expect(steps.every(step=>Math.abs(step.x)<=5000&&Math.abs(step.y)<=5000)).toBe(true);
  expect(steps.reduce((sum,step)=>sum+step.x,0)).toBe(9100);
  expect(steps.reduce((sum,step)=>sum+step.y,0)).toBe(-12300);
  expect(scrollSteps({x:101000,y:0},20)).toBeNull();
});
