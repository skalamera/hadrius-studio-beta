from PIL import Image

# Let's inspect slide_02.png
im2 = Image.open('out/Archiving-LLMs-Claude/slides/slide_02.png')

# Claude card container: { x: 310, y: 386, width: 401, height: 165 }
crop2 = im2.crop((310, 386, 310 + 401, 386 + 165))
crop2.save('/tmp/crop_slide2_claude.png')

# Slide 3: Connection details
im3 = Image.open('out/Archiving-LLMs-Claude/slides/slide_03.png')
# { x: 310, y: 403, width: 900, height: 431 }
crop3 = im3.crop((310, 403, 310 + 900, 403 + 431))
crop3.save('/tmp/crop_slide3_conn.png')

# Slide 4: At a glance
im4 = Image.open('out/Archiving-LLMs-Claude/slides/slide_04.png')
# { x: 1226, y: 319, width: 320, height: 476 }
crop4 = im4.crop((1226, 319, 1226 + 320, 319 + 476))
crop4.save('/tmp/crop_slide4_glance.png')

# Slide 5: Event log table
im5 = Image.open('out/Archiving-LLMs-Claude/slides/slide_05.png')
# Table header + first 6 rows: x=290, y=259, width=1276, height=430
crop5 = im5.crop((290, 259, 290 + 1276, 259 + 430))
crop5.save('/tmp/crop_slide5_table.png')

# Slide 6: Event drawer
im6 = Image.open('out/Archiving-LLMs-Claude/slides/slide_06.png')
# Drawer panel on right: x=1156, y=209, width=410, height=675
crop6 = im6.crop((1156, 209, 1156 + 410, 209 + 675))
crop6.save('/tmp/crop_slide6_drawer.png')

print("All crops saved successfully!")
