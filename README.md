# test-custom-action

This test action.

## Inputs

### `who-to-greet`

**Required** The name of the person to greet. Default `"World"`.

## Outputs

### `time`

The time we greeted you.

## Example usage

```yaml
uses: actions/test-custom-action@v0.0.1
with:
  who-to-greet: "Mona the Octocat"
```
