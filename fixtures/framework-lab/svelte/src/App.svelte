<script lang="ts">
  let items = ['One', 'Two'];
</script>

<main class="app">
  <nav id="top-nav">
    {#each items as it}
      <a href="/">{it}</a>
    {/each}
  </nav>
  <section class="hero">
    <h1 data-testid="title">Hej</h1>
    <p class="tagline">Old tagline</p>
  </section>
</main>

<style>
  .hero {
    background: white;
  }
  .tagline {
    color: gray;
  }
</style>
