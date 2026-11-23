Indexing a large codebase quickly, without compromising privacy or speed, isn’t trivial.

But Cursor figured out a clever system using Merkle trees. 

And it’s worth understanding, because this same idea shows up in other places too.

At its core, a Merkle tree is just a hash tree. 

You take your files, hash them, then hash those hashes all the way up to a root. 

If anything changes, the hashes ripple upward. 

This lets you tell fast, what changed and where.

Cursor uses this for code indexing. 

The IDE splits your code into meaningful chunks, builds a Merkle tree locally, and sends only the hashes to the server. 

If something changes, the tree tells you exactly which files are different, so only those need to be reprocessed.

On top of that, each chunk is embedded and stored (obfuscated) in a vector DB. 

When you ask a question, the IDE finds the most relevant code chunks, by embedding your query, searching the DB, then pulling the actual code from your local files. 

This keeps the code private and the answers context-aware.

The clever bit is that all of this: change detection, deduplication, efficient sync, and semantic recall, rides on top of that one core structure: the Merkle tree.