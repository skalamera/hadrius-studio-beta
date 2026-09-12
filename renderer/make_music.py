"""Generate a playful, royalty-free music bed with ffmpeg synthesis (no samples).
124 BPM, C–Am–F–G, bouncy kick + hat + shaker, marimba-style syncopated arpeggio, bell counter-melody, soft pad.
Output: assets/music_upbeat.wav
"""
import subprocess, sys
BPM = 108; B = 60 / BPM; BAR = 4 * B; CH = 2 * BAR; LOOP = 4 * CH
DUR = float(sys.argv[1]) if len(sys.argv) > 1 else 150
# chord tones one octave up for brightness (C, Am, F, G)
chords = [(523.25, 659.26, 783.99, 1046.5), (440.00, 523.25, 659.26, 880.00), (349.23, 440.00, 523.25, 698.46), (392.00, 493.88, 587.33, 783.99)]
roots = [130.81, 110.00, 87.31, 98.00]

def sel(vals):
    e = f"{vals[3]}"
    for i in (2, 1, 0): e = f"if(lt(mod(t,{LOOP:.4f}),{(i+1)*CH:.4f}),{vals[i]},{e})"
    return e
def seq_tone(seq, step, k_of):  # cycle a sequence of chord-tone indices at a fixed step
    e = k_of(seq[-1])
    for i in range(len(seq) - 2, -1, -1): e = f"if(lt(mod(t,{len(seq)*step:.4f}),{(i+1)*step:.4f}),{k_of(seq[i])},{e})"
    return e
tone = lambda k: sel([c[k] for c in chords])

# marimba-ish pluck: fundamental + bright 2nd/4th partials, fast decay, 16th-note syncopated pattern (rest = tone index 4 -> silent via gate)
step16 = B / 4
pat = [0, 2, 1, 3, 0, 3, 2, 1, 0, 2, 3, 1, 2, 0, 3, 2]
gate = [1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1]
g = seq_tone(gate, step16, lambda v: str(v))
f = seq_tone(pat, step16, tone)
arp = f"({g})*(0.55*sin(2*PI*t*({f}))+0.18*sin(4*PI*t*({f}))+0.08*sin(8*PI*t*({f})))*exp(-9*mod(t,{step16:.4f}))"

# bell counter-melody: dotted-8th pulses on the 5th/octave, long ring
bell_f = seq_tone([2, 3, 2, 1], B * 1.5, tone)
bell = f"0.22*(sin(2*PI*t*({bell_f})*2)+0.4*sin(2*PI*t*({bell_f})*2*2.76))*exp(-3.5*mod(t,{B*1.5:.4f}))"

kick = f"0.95*sin(2*PI*54*t*(1+2.2*exp(-32*mod(t,{B:.4f}))))*exp(-15*mod(t,{B:.4f}))"
hat = f"0.28*random(0)*exp(-70*mod(t+{B/2:.4f},{B:.4f}))"
shaker = f"0.14*random(0)*exp(-45*mod(t,{B/2:.4f}))"
bass = f"0.6*(sin(2*PI*t*({sel(roots)}))+0.2*sin(4*PI*t*({sel(roots)})))*exp(-5*mod(t,{B/2:.4f}))*if(lt(mod(t,{B:.4f}),{B*0.7:.4f}),1,0.35)"
pad = "+".join(f"0.1*sin(2*PI*t*({tone(k)})/2)" for k in range(3))

fc = (f"[0:a]lowpass=f=170[k];[1:a]highpass=f=6500,lowpass=f=12000[h];[2:a]highpass=f=3000,lowpass=f=9000[sh];[3:a]lowpass=f=520[b];"
      f"[4:a]lowpass=f=5000,aecho=0.5:0.3:{int(B*1000*0.75)}:0.25[a];[5:a]lowpass=f=6000,aecho=0.6:0.4:{int(B*1000*1.5)}:0.3[be];[6:a]lowpass=f=1000,tremolo=f=0.3:d=0.2[p];"
      f"[k][h][sh][b][a][be][p]amix=inputs=7:weights='1 0.7 0.6 0.9 1.0 0.7 0.5':normalize=0,acompressor=threshold=-14dB:ratio=3:attack=8:release=110,"
      f"afade=t=in:d=1.2,afade=t=out:st={DUR-3:.1f}:d=3,volume=0.75[m]")
src = lambda e: ['-f', 'lavfi', '-i', f"aevalsrc='{e}':s=48000:d={DUR}"]
cmd = ['ffmpeg', '-y', *src(kick), *src(hat), *src(shaker), *src(bass), *src(arp), *src(bell), *src(pad), '-filter_complex', fc, '-map', '[m]', '-ac', '1', 'assets/music_upbeat.wav']
subprocess.run(cmd, check=True, capture_output=True)
print('assets/music_upbeat.wav', DUR, 's')
