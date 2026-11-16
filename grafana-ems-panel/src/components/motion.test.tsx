import React, { useRef } from 'react';
import { frameSubscribers, keyframeOf, mo, parseMotion, sample, useMotion } from './motion';

// El scheduler de React toma MessageChannel al cargarse; el de worker_threads (jest-setup) deja el proceso de
// Jest abierto al terminar. Sin él usa setTimeout. Por eso react-dom se carga aquí, después de quitarlo.
delete (global as { MessageChannel?: unknown }).MessageChannel;
const { act, render } = require('@testing-library/react') as typeof import('@testing-library/react');

describe('animaciones declarativas (data-mo)', () => {
  it('codifica y decodifica las pistas', () => {
    const { 'data-mo': code } = mo(
      { attr: 'translate', values: ['0,0', '10,-4'], dur: 2, offset: 0.5 },
      { attr: 'opacity', values: [0, 0.85, 0], dur: 2 }
    );
    const [move, fade] = parseMotion(code);
    expect(move).toEqual({
      attr: 'translate',
      values: [
        [0, 0],
        [10, -4],
      ],
      keyTimes: [0, 1],
      dur: 2,
      offset: 0.5,
    });
    expect(fade.keyTimes).toEqual([0, 0.5, 1]);
  });

  it('interpola por tramos con tiempos clave, como calcMode="linear"', () => {
    const [walk] = parseMotion(
      mo({ attr: 'translate', values: ['0,0', '10,20', '10,20', '0,0'], keyTimes: [0, 0.3, 0.5, 0.8], dur: 9 })[
        'data-mo'
      ]
    );
    expect(sample(walk, 0.15)).toEqual([5, 10]);
    expect(sample(walk, 0.4)).toEqual([10, 20]);
    expect(sample(walk, 0.9)).toEqual([0, 0]);
  });

  it('traduce las pistas a fotogramas CSS para Web Animations', () => {
    const [spin] = parseMotion(mo({ attr: 'rotate', values: ['0 5 6', '360 5 6'], dur: 1 })['data-mo']);
    expect(keyframeOf(spin, [90, 5, 6])).toEqual({
      transform: 'translate(5px,6px) rotate(90deg) translate(-5px,-6px)',
    });
    const [dash] = parseMotion(mo({ attr: 'stroke-dashoffset', values: [24, 0], dur: 1 })['data-mo']);
    expect(keyframeOf(dash, [12])).toEqual({ strokeDashoffset: '12' });
  });
});

describe('useMotion (respaldo rAF sin Web Animations)', () => {
  let frames: FrameRequestCallback[] = [];
  let now = 0;
  beforeEach(() => {
    frames = [];
    now = 0;
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const tick = (ms: number) =>
    act(() => {
      now += ms;
      const run = frames;
      frames = [];
      run.forEach((cb) => cb(now));
    });

  const Scene = ({ active }: { active: boolean }) => {
    const ref = useRef<SVGSVGElement>(null);
    useMotion(ref, active);
    return (
      <svg ref={ref}>
        <circle data-testid="dot" {...(active ? mo({ attr: 'translate', values: ['0,0', '0,10'], dur: 1 }) : {})} />
      </svg>
    );
  };

  it('mueve los elementos con el reloj visual y se detiene al pausar', () => {
    const { getByTestId, rerender } = render(<Scene active />);
    const dot = getByTestId('dot');
    expect(dot.getAttribute('transform')).toBe('translate(0.0,0.0)');
    expect(frameSubscribers()).toBe(1);
    tick(16); // primer frame: 16 ms
    for (let i = 0; i < 10; i++) {
      tick(50);
    }
    // 516 ms de 1 s: a mitad de camino, sin saltos aunque no haya renders de React
    expect(dot.getAttribute('transform')).toBe('translate(0.0,5.2)');
    rerender(<Scene active={false} />);
    expect(frameSubscribers()).toBe(0);
  });
});
